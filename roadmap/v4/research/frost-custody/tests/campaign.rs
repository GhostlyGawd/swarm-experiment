use aether_frost_custody_research::{
    bytes,
    channel::{self, Config},
    custody::{ensure, private_write, Context, Delivery},
    digest, hex, Result,
};
use frost_ristretto255 as frost;
use rcgen::{
    BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::process::ExitStatusExt,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    time::Instant,
};

const BINARY: &str = env!("CARGO_BIN_EXE_aether-frost-custody-research");
struct Peer {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    address: String,
}
impl Peer {
    fn start(config: &Path, fault: Option<&str>) -> Result<Self> {
        let mut command = Command::new(BINARY);
        command
            .arg(config)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_remove("AETHER_CUSTODY_FAULT");
        if let Some(fault) = fault {
            command.env("AETHER_CUSTODY_FAULT", fault);
        }
        let mut child = command.spawn()?;
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut peer = Self {
            child,
            input,
            output,
            address: String::new(),
        };
        let ready = peer.read()?;
        peer.address = ready["ready"]
            .as_str()
            .ok_or("worker did not start")?
            .into();
        Ok(peer)
    }
    fn read(&mut self) -> Result<Value> {
        let mut line = String::new();
        require_line(self.output.read_line(&mut line)? > 0)?;
        Ok(serde_json::from_str(&line)?)
    }
    fn request(&mut self, value: Value) -> Result<Value> {
        writeln!(self.input, "{value}")?;
        self.input.flush()?;
        self.read()
    }
    fn call(&mut self, value: Value) -> Value {
        let reply = self.request(value).unwrap();
        assert_eq!(reply["ok"], true, "worker refused: {}", reply["error"]);
        reply["value"].clone()
    }
    fn reject(&mut self, value: Value) -> String {
        let reply = self.request(value).unwrap();
        assert_eq!(reply["ok"], false);
        reply["error"].as_str().unwrap().into()
    }
    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn require_line(value: bool) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err("worker closed control channel".into())
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.stop();
    }
}
struct Harness {
    root: PathBuf,
    configs: Vec<Config>,
    paths: Vec<PathBuf>,
    peers: Vec<Peer>,
    rogue: Config,
    vote: Value,
}
impl Harness {
    fn new() -> Self {
        let mut random = [0u8; 32];
        SystemRandom::new().fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!("aether-custody-{}", hex(&random)));
        ensure(&root).unwrap();
        let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca_params.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyCertSign,
        ];
        let ca_key = KeyPair::generate().unwrap();
        let ca = ca_params.self_signed(&ca_key).unwrap();
        let issuer = Issuer::new(ca_params, ca_key);
        let ca_path = root.join("ca.der");
        private_write(&ca_path, ca.der()).unwrap();
        let mut certificates = Vec::new();
        let mut secrets = Vec::new();
        let mut members = BTreeMap::new();
        for index in 1..=5 {
            let key = KeyPair::generate().unwrap();
            let mut params =
                CertificateParams::new(vec![format!("participant-{index}.test")]).unwrap();
            params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
            params.extended_key_usages = vec![
                ExtendedKeyUsagePurpose::ClientAuth,
                ExtendedKeyUsagePurpose::ServerAuth,
            ];
            let cert = params.signed_by(&key, &issuer).unwrap();
            let path = root.join(format!("participant-{index}.der"));
            private_write(&path, cert.der()).unwrap();
            let secret = root.join(format!("participant-{index}.key"));
            private_write(&secret, &key.serialize_der()).unwrap();
            if index <= 4 {
                members.insert(index, digest(cert.der()));
            }
            certificates.push(path);
            secrets.push(secret);
        }
        let vote: Value = serde_json::from_str(include_str!("../fixtures/vote.json")).unwrap();
        let context = Context {
            format: "aether.custody-context/1".into(),
            group: hex(&random),
            session: hex(&random[..16]),
            repository: vote["repositoryId"].as_str().unwrap().into(),
            membership_epoch: vote["membershipEpoch"].as_str().unwrap().into(),
            policy_epoch: vote["policyEpoch"].as_str().unwrap().into(),
            roster: digest(&serde_json::to_vec(&members).unwrap()),
            vote_digest: digest(&serde_json::to_vec(&vote).unwrap()),
        };
        let mut configs = Vec::new();
        let mut paths = Vec::new();
        let mut peers = Vec::new();
        for index in 1..=4 {
            let home = root.join(format!("node-{index}"));
            ensure(&home).unwrap();
            let master = home.join("master.key");
            let mut key = [0u8; 32];
            SystemRandom::new().fill(&mut key).unwrap();
            private_write(&master, &key).unwrap();
            let config = Config {
                participant: index,
                context: context.clone(),
                directory: home.join("state"),
                master,
                ca: ca_path.clone(),
                certificate: certificates[usize::from(index - 1)].clone(),
                private_key: secrets[usize::from(index - 1)].clone(),
                members: members.clone(),
            };
            let path = home.join("config.json");
            private_write(&path, &serde_json::to_vec(&config).unwrap()).unwrap();
            peers.push(Peer::start(&path, None).unwrap());
            configs.push(config);
            paths.push(path);
        }
        let mut rogue = configs[0].clone();
        rogue.certificate = certificates[4].clone();
        rogue.private_key = secrets[4].clone();
        Self {
            root,
            configs,
            paths,
            peers,
            rogue,
            vote,
        }
    }
    fn send(&mut self, sender: usize, phase: &str, omit: Option<usize>) -> Value {
        let targets = self
            .peers
            .iter()
            .enumerate()
            .filter(|(index, _)| *index != sender && Some(*index) != omit)
            .map(|(index, peer)| ((index + 1).to_string(), peer.address.clone()))
            .collect::<BTreeMap<_, _>>();
        self.peers[sender].call(json!({"op":"Send","phase":phase,"targets":targets}))
    }
    fn round1(&mut self) {
        for peer in &mut self.peers {
            peer.call(json!({"op":"Start"}));
        }
        for index in 0..4 {
            self.send(index, "r1", None);
        }
        for index in 0..4 {
            self.send(index, "agreement", None);
        }
        for peer in &mut self.peers {
            peer.call(json!({"op":"Part2"}));
        }
    }
    fn dkg(&mut self) -> String {
        self.round1();
        for index in 0..4 {
            self.send(index, "r2", None);
        }
        let public = self
            .peers
            .iter_mut()
            .map(|peer| {
                peer.call(json!({"op":"Part3"}))["public_package"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert!(public.iter().all(|value| value == &public[0]));
        public[0].clone()
    }
    fn restart(&mut self, index: usize, fault: Option<&str>) {
        self.peers[index].stop();
        self.peers[index] = Peer::start(&self.paths[index], fault).unwrap();
    }
    fn subject(&self, public: &str) -> String {
        let package = frost::keys::PublicKeyPackage::deserialize(&bytes(public).unwrap()).unwrap();
        let message = json!({"format":"aether.custody-vote/1","context":self.configs[0].context,"group_public_key":hex(&package.verifying_key().serialize().unwrap()),"vote":self.vote});
        hex(&serde_json::to_vec(&message).unwrap())
    }
    fn reserve(&mut self, nonce: &str, message: &str) -> String {
        let mut commitments = BTreeMap::new();
        for index in 0..3 {
            let reply =
                self.peers[index].call(json!({"op":"Reserve","nonce":nonce,"message":message}));
            commitments.insert(
                ((index + 1) as u16).try_into().unwrap(),
                frost::round1::SigningCommitments::deserialize(
                    &bytes(reply["commitments"].as_str().unwrap()).unwrap(),
                )
                .unwrap(),
            );
        }
        hex(
            &frost::SigningPackage::new(commitments, &bytes(message).unwrap())
                .serialize()
                .unwrap(),
        )
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        for peer in &mut self.peers {
            peer.stop();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn direct_mutual_tls_dkg_and_encrypted_nonce_restart_produce_a_valid_threshold_signature() {
    let started = Instant::now();
    let mut h = Harness::new();
    let public = h.dkg();
    let dkg_ns = started.elapsed().as_nanos();
    let message = h.subject(&public);
    let package = h.reserve("normal", &message);
    let before = h.peers[0].call(json!({"op":"Status"}));
    h.restart(0, None);
    let after = h.peers[0].call(json!({"op":"Status"}));
    assert_eq!(before, after);
    let mut shares = BTreeMap::new();
    for index in 0..3 {
        let value = h.peers[index].call(json!({"op":"Sign","nonce":"normal","package":package}));
        assert_eq!(value["cached"], false);
        shares.insert(
            ((index + 1) as u16).try_into().unwrap(),
            frost::round2::SignatureShare::deserialize(
                &bytes(value["share"].as_str().unwrap()).unwrap(),
            )
            .unwrap(),
        );
    }
    let public = frost::keys::PublicKeyPackage::deserialize(&bytes(&public).unwrap()).unwrap();
    let signing = frost::SigningPackage::deserialize(&bytes(&package).unwrap()).unwrap();
    for (id, share) in &shares {
        frost_core::verify_signature_share(
            *id,
            &public.verifying_shares()[id],
            share,
            &signing,
            public.verifying_key(),
        )
        .unwrap();
    }
    let signature = frost::aggregate(&signing, &shares, &public).unwrap();
    public
        .verifying_key()
        .verify(&bytes(&message).unwrap(), &signature)
        .unwrap();
    h.restart(0, None);
    let cached = h.peers[0].call(json!({"op":"Sign","nonce":"normal","package":package}));
    assert_eq!(cached["cached"], true);
    assert_eq!(
        cached["share"],
        hex(&shares[&1u16.try_into().unwrap()].serialize())
    );
    h.peers[0].reject(json!({"op":"Reserve","nonce":"normal","message":message}));
    let encrypted = fs::read(h.configs[0].directory.join("custody.enc")).unwrap();
    assert!(!encrypted
        .windows(message.len())
        .any(|part| part == message.as_bytes()));
    assert!(serde_json::from_slice::<Value>(&encrypted).unwrap()["ciphertext"].is_string());
    println!(
        "EVIDENCE {}",
        json!({"scenario":"tls-dkg-custody-restart","dkg_with_setup_ns":dkg_ns.to_string(),"total_ns":started.elapsed().as_nanos().to_string(),"participants":4,"participant_pids":h.peers.iter().map(|peer|peer.child.id()).collect::<Vec<_>>(),"tls_members":h.configs[0].members,"threshold":3,"tls":"TLSv1_3","signature":hex(&signature.serialize().unwrap()),"group_public_key":hex(&public.verifying_key().serialize().unwrap()),"message_hex":message,"cached_receipt":true})
    );
}

#[test]
fn real_sigkill_at_each_nonce_boundary_never_reuses_a_consumed_nonce() {
    let mut h = Harness::new();
    let public = h.dkg();
    let message = h.subject(&public);
    for (round, point) in [
        "after-burn-marker",
        "after-burn-state",
        "after-sign-before-receipt",
        "after-share-receipt",
    ]
    .iter()
    .enumerate()
    {
        let nonce = format!("crash-{round}");
        let package = h.reserve(&nonce, &message);
        h.restart(0, Some(point));
        let outcome = h.peers[0].request(json!({"op":"Sign","nonce":nonce,"package":package}));
        assert!(outcome.is_err());
        assert_eq!(
            h.peers[0].child.wait().unwrap().signal(),
            Some(libc::SIGKILL)
        );
        h.restart(0, None);
        if *point == "after-share-receipt" {
            assert_eq!(
                h.peers[0].call(json!({"op":"Sign","nonce":nonce,"package":package}))["cached"],
                true
            );
        } else {
            assert!(h.peers[0]
                .reject(json!({"op":"Sign","nonce":nonce,"package":package}))
                .contains("consumed"));
        }
        h.peers[0].reject(json!({"op":"Reserve","nonce":nonce,"message":message}));
        println!(
            "EVIDENCE {}",
            json!({"scenario":point,"signal":"SIGKILL","nonce_reused":false,"cached_receipt":*point=="after-share-receipt"})
        );
    }
}

#[test]
fn stale_state_file_wrong_master_context_and_corruption_fail_closed() {
    let mut h = Harness::new();
    let public = h.dkg();
    let message = h.subject(&public);
    let package = h.reserve("rollback", &message);
    let path = h.configs[0].directory.join("custody.enc");
    let pending = fs::read(&path).unwrap();
    h.peers[0].call(json!({"op":"Sign","nonce":"rollback","package":package}));
    let complete = fs::read(&path).unwrap();
    h.peers[0].stop();
    fs::write(&path, &pending).unwrap();
    h.restart(0, None);
    assert!(h.peers[0]
        .reject(json!({"op":"Sign","nonce":"rollback","package":package}))
        .contains("consumed"));
    h.peers[0].stop();
    fs::write(&path, &complete).unwrap();
    let mut corrupt: Value = serde_json::from_slice(&complete).unwrap();
    let bytes = corrupt["ciphertext"].as_str().unwrap().to_string();
    corrupt["ciphertext"] = Value::String(format!(
        "{}{}",
        if &bytes[..2] == "00" { "01" } else { "00" },
        &bytes[2..]
    ));
    fs::write(&path, serde_json::to_vec(&corrupt).unwrap()).unwrap();
    assert!(Peer::start(&h.paths[0], None).is_err());
    fs::write(&path, &complete).unwrap();
    let master = fs::read(&h.configs[0].master).unwrap();
    fs::write(&h.configs[0].master, [0u8; 32]).unwrap();
    assert!(Peer::start(&h.paths[0], None).is_err());
    fs::write(&h.configs[0].master, master).unwrap();
    let mut stale = h.configs[0].clone();
    stale.context.policy_epoch = "6".into();
    let alternate = h.root.join("stale.json");
    private_write(&alternate, &serde_json::to_vec(&stale).unwrap()).unwrap();
    assert!(Peer::start(&alternate, None).is_err());
    fs::remove_file(&path).unwrap();
    assert!(Peer::start(&h.paths[0], None).is_err());
    fs::write(&path, complete).unwrap();
}

#[test]
fn exact_sender_recipient_epoch_and_enrolled_tls_identity_are_enforced() {
    let mut h = Harness::new();
    let destination = h.peers[1].address.clone();
    let probe = Delivery {
        context: h.configs[0].context.clone(),
        from: 1,
        to: 2,
        phase: "probe".into(),
        payload: hex(b"confidential-channel-probe"),
    };
    let accepted =
        h.peers[0].call(json!({"op":"Raw","to":2,"address":destination,"delivery":probe}));
    assert_eq!(accepted["tls"], "TLSv1_3");
    let state = h.peers[1].call(json!({"op":"Status"}));
    let duplicate =
        h.peers[0].call(json!({"op":"Raw","to":2,"address":destination,"delivery":probe}));
    assert_eq!(duplicate["receipt"]["duplicate"], true);
    assert_eq!(h.peers[1].call(json!({"op":"Status"})), state);
    for kind in [
        "sender",
        "recipient",
        "session",
        "membership",
        "policy",
        "group",
        "payload",
    ] {
        let mut changed = probe.clone();
        match kind {
            "sender" => changed.from = 3,
            "recipient" => changed.to = 3,
            "session" => changed.context.session = "00".repeat(16),
            "membership" => changed.context.membership_epoch = "3".into(),
            "policy" => changed.context.policy_epoch = "6".into(),
            "group" => changed.context.group = "00".repeat(32),
            _ => changed.payload = hex(b"conflicting payload"),
        };
        h.peers[0].reject(json!({"op":"Raw","to":2,"address":destination,"delivery":changed}));
        assert_eq!(h.peers[1].call(json!({"op":"Status"})), state);
    }
    assert!(channel::send(&h.rogue, 2, &destination, &probe).is_err());
    assert!(channel::send(&h.configs[0], 2, &h.peers[2].address, &probe).is_err());
    println!(
        "EVIDENCE {}",
        json!({"scenario":"mutual-tls-identity-and-replay","valid_delivery":true,"duplicate_idempotent":true,"wrong_contexts_rejected":7,"unrostered_ca_signed_client_rejected":true,"wrong_server_rejected":true})
    );
}

#[test]
fn withheld_and_malicious_private_packages_cannot_finish_dkg() {
    let mut h = Harness::new();
    h.round1();
    for index in 0..4 {
        h.send(index, "r2", if index == 0 { Some(1) } else { None });
    }
    assert!(h.peers[1]
        .reject(json!({"op":"Part3"}))
        .contains("withheld"));
    h.send(0, "r2", None);
    h.peers[1].call(json!({"op":"Part3"}));
    let mut bad = Harness::new();
    bad.round1();
    let payload = Delivery {
        context: bad.configs[0].context.clone(),
        from: 1,
        to: 2,
        phase: "r2".into(),
        payload: "ff".into(),
    };
    let address = bad.peers[1].address.clone();
    bad.peers[0].call(json!({"op":"Raw","to":2,"address":address,"delivery":payload}));
    for index in 1..4 {
        bad.send(index, "r2", None);
    }
    bad.peers[1].reject(json!({"op":"Part3"}));
    assert_eq!(bad.peers[1].call(json!({"op":"Status"}))["ready"], false);
    bad.peers[0].reject(json!({"op":"Send","phase":"r2","targets":{"2":address}}));
}

#[test]
fn inconsistent_authenticated_round_one_agreement_prevents_progress() {
    let mut h = Harness::new();
    for peer in &mut h.peers {
        peer.call(json!({"op":"Start"}));
    }
    for index in 0..4 {
        h.send(index, "r1", None);
    }
    let wrong = Delivery {
        context: h.configs[0].context.clone(),
        from: 1,
        to: 2,
        phase: "agreement".into(),
        payload: hex(br#"{"1":"wrong"}"#),
    };
    let address = h.peers[1].address.clone();
    h.peers[0].call(json!({"op":"Raw","to":2,"address":address,"delivery":wrong}));
    for index in 1..4 {
        h.send(index, "agreement", None);
    }
    assert!(h.peers[1]
        .reject(json!({"op":"Part2"}))
        .contains("inconsistent"));
}

#[test]
fn tls_wire_capture_excludes_plaintext_probe_even_through_an_untrusted_relay() {
    let mut h = Harness::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let destination = h.peers[1].address.clone();
    let capture = Arc::new(Mutex::new(Vec::new()));
    let observed = capture.clone();
    let relay = std::thread::spawn(move || {
        let (mut client, _) = listener.accept().unwrap();
        let mut server = TcpStream::connect(destination).unwrap();
        let mut reverse_server = server.try_clone().unwrap();
        let mut reverse_client = client.try_clone().unwrap();
        let reverse = std::thread::spawn(move || {
            let _ = std::io::copy(&mut reverse_server, &mut reverse_client);
        });
        let mut buffer = [0u8; 4096];
        loop {
            let count = client.read(&mut buffer).unwrap_or(0);
            if count == 0 {
                break;
            }
            observed.lock().unwrap().extend_from_slice(&buffer[..count]);
            if server.write_all(&buffer[..count]).is_err() {
                break;
            }
        }
        let _ = server.shutdown(std::net::Shutdown::Both);
        let _ = reverse.join();
    });
    let secret = b"opaque-DKG-channel-probe-53d56c19599644709945";
    let delivery = Delivery {
        context: h.configs[0].context.clone(),
        from: 1,
        to: 2,
        phase: "probe".into(),
        payload: hex(secret),
    };
    h.peers[0].call(json!({"op":"Raw","to":2,"address":address,"delivery":delivery}));
    relay.join().unwrap();
    let wire = capture.lock().unwrap();
    assert!(wire.len() > secret.len());
    assert!(!wire.windows(secret.len()).any(|value| value == secret));
    let encoded = hex(secret);
    assert!(!wire
        .windows(encoded.len())
        .any(|value| value == encoded.as_bytes()));
    println!(
        "EVIDENCE {}",
        json!({"scenario":"tls-ciphertext-relay","captured_bytes":wire.len(),"probe_plaintext_absent":true,"probe_hex_absent":true})
    );
}

#[test]
fn concurrent_controllers_cannot_use_one_nonce_for_two_different_commitment_sets() {
    let mut h = Harness::new();
    let public = h.dkg();
    let message = h.subject(&public);
    let first = h.reserve("raced", &message);
    let parsed = frost::SigningPackage::deserialize(&bytes(&first).unwrap()).unwrap();
    let mut commitments = parsed.signing_commitments().clone();
    for index in 1..3 {
        let reply =
            h.peers[index].call(json!({"op":"Reserve","nonce":"alternate","message":message}));
        commitments.insert(
            ((index + 1) as u16).try_into().unwrap(),
            frost::round1::SigningCommitments::deserialize(
                &bytes(reply["commitments"].as_str().unwrap()).unwrap(),
            )
            .unwrap(),
        );
    }
    let second = hex(
        &frost::SigningPackage::new(commitments, &bytes(&message).unwrap())
            .serialize()
            .unwrap(),
    );
    let mut competitor = Peer::start(&h.paths[0], None).unwrap();
    writeln!(
        h.peers[0].input,
        "{}",
        json!({"op":"Sign","nonce":"raced","package":first})
    )
    .unwrap();
    h.peers[0].input.flush().unwrap();
    writeln!(
        competitor.input,
        "{}",
        json!({"op":"Sign","nonce":"raced","package":second})
    )
    .unwrap();
    competitor.input.flush().unwrap();
    let replies = [h.peers[0].read().unwrap(), competitor.read().unwrap()];
    assert_eq!(
        replies.iter().filter(|value| value["ok"] == true).count(),
        1
    );
    let winner = if replies[0]["ok"] == true {
        &first
    } else {
        &second
    };
    let loser = if replies[0]["ok"] == true {
        &second
    } else {
        &first
    };
    let receipt = h.peers[0].call(json!({"op":"Sign","nonce":"raced","package":winner}));
    assert_eq!(receipt["cached"], true);
    h.peers[0].reject(json!({"op":"Sign","nonce":"raced","package":loser}));
    let public = frost::keys::PublicKeyPackage::deserialize(&bytes(&public).unwrap()).unwrap();
    let identifier = 1u16.try_into().unwrap();
    let share = frost::round2::SignatureShare::deserialize(
        &bytes(receipt["share"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    let package = frost::SigningPackage::deserialize(&bytes(winner).unwrap()).unwrap();
    frost_core::verify_signature_share(
        identifier,
        &public.verifying_shares()[&identifier],
        &share,
        &package,
        public.verifying_key(),
    )
    .unwrap();
    println!(
        "EVIDENCE {}",
        json!({"scenario":"concurrent-nonce-custody","successful_competing_shares":1,"rejected_competing_packages":1,"cached_retry":true})
    );
}

#[test]
fn exact_subject_refusal_is_atomic_and_invalid_signing_attempts_burn_durably() {
    let mut h = Harness::new();
    let public = h.dkg();
    let message = h.subject(&public);
    let package = h.reserve("bad-sign", &message);
    let before = h.peers[0].call(json!({"op":"Status"}));
    for kind in [
        "group",
        "session",
        "membership",
        "policy",
        "vote",
        "encoding",
    ] {
        let mut value: Value = serde_json::from_slice(&bytes(&message).unwrap()).unwrap();
        match kind {
            "group" => value["group_public_key"] = Value::String("00".repeat(32)),
            "session" => value["context"]["session"] = Value::String("00".repeat(16)),
            "membership" => value["context"]["membership_epoch"] = Value::String("3".into()),
            "policy" => value["context"]["policy_epoch"] = Value::String("6".into()),
            "vote" => value["vote"]["view"] = Value::String("4".into()),
            _ => {}
        }
        let encoded = if kind == "encoding" {
            hex(serde_json::to_string_pretty(&value).unwrap().as_bytes())
        } else {
            hex(&serde_json::to_vec(&value).unwrap())
        };
        h.peers[0].reject(json!({"op":"Reserve","nonce":format!("bad-{kind}"),"message":encoded}));
        assert_eq!(h.peers[0].call(json!({"op":"Status"})), before);
    }
    h.peers[0].reject(json!({"op":"Sign","nonce":"bad-sign","package":"ff"}));
    h.restart(0, None);
    assert!(h.peers[0]
        .reject(json!({"op":"Sign","nonce":"bad-sign","package":package}))
        .contains("consumed"));
    println!(
        "EVIDENCE {}",
        json!({"scenario":"exact-subject-and-failed-attempt","subject_refusals":6,"refusal_atomic":true,"invalid_attempt_burn_survives_restart":true})
    );
}
