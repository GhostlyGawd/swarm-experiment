use aether_frost_prototype::{bytes, hex, id, Participant, Request, Result};
use frost_ed25519 as frost;
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    env, fs,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::Instant,
};

fn worker(identifier: u16) -> Result<()> {
    let mut participant = Participant::new(identifier)?;
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.len() > 1024 * 1024 {
            return Err("IPC frame too large".into());
        }
        let began = Instant::now();
        let result = serde_json::from_str::<Request>(&line)
            .map_err(|error| format!("invalid request schema: {error}"))
            .and_then(|request| participant.handle(request));
        let reply = match result {
            Ok(value) => {
                json!({"ok": true, "value": value, "elapsed_ns": began.elapsed().as_nanos().to_string(), "pid": std::process::id(), "participant": identifier})
            }
            Err(error) => {
                json!({"ok": false, "error": error, "elapsed_ns": began.elapsed().as_nanos().to_string(), "pid": std::process::id(), "participant": identifier})
            }
        };
        println!("{}", reply);
        std::io::stdout().flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}
struct Peer {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    identifier: u16,
}
impl Peer {
    fn new(identifier: u16) -> Result<Self> {
        let mut child = Command::new(env::current_exe().map_err(|e| e.to_string())?)
            .args(["worker", &identifier.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            child,
            identifier,
        })
    }
    fn send(&mut self, value: &Value) -> Result<()> {
        writeln!(self.input, "{}", value)
            .and_then(|_| self.input.flush())
            .map_err(|e| e.to_string())
    }
    fn receive(&mut self) -> Result<Value> {
        let mut line = String::new();
        self.output
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        let value: Value = serde_json::from_str(&line)
            .map_err(|_| "participant response unavailable/malformed")?;
        if value["participant"] != self.identifier {
            return Err("participant channel mismatch".into());
        }
        Ok(value)
    }
    fn request(&mut self, value: Value) -> Result<Value> {
        self.send(&value)?;
        self.receive()
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn accepted(reply: &Value) -> Result<&Value> {
    if reply["ok"] != true {
        return Err(format!("participant rejected: {}", reply["error"]));
    }
    Ok(&reply["value"])
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or_else(|| format!("missing {key}"))
}
fn require_rejection(reply: Value, scenario: &str, checks: &mut Vec<Value>) -> Result<()> {
    if reply["ok"] != false {
        return Err(format!("unsafe acceptance: {scenario}"));
    }
    checks.push(json!({"scenario": scenario, "rejected": true, "error": reply["error"]}));
    Ok(())
}
fn identifier_map(value: &Value) -> Result<BTreeMap<u16, String>> {
    serde_json::from_value(value.clone()).map_err(|_| "invalid package map".into())
}

struct Generated {
    peers: Vec<Peer>,
    public: frost::keys::PublicKeyPackage,
    session: String,
    transcript: Value,
}
fn dkg() -> Result<Generated> {
    let started = Instant::now();
    let mut random = [0u8; 16];
    OsRng.fill_bytes(&mut random);
    let session = hex(&random);
    let mut peers = (1..=4).map(Peer::new).collect::<Result<Vec<_>>>()?;
    for peer in &mut peers {
        peer.send(&json!({"op":"Begin", "session":session}))?;
    }
    let r1 = peers
        .iter_mut()
        .map(Peer::receive)
        .collect::<Result<Vec<_>>>()?;
    let packages = r1
        .iter()
        .enumerate()
        .map(|(index, reply)| {
            Ok((
                (index + 1) as u16,
                text(accepted(reply)?, "package")?.to_string(),
            ))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;
    for peer in &mut peers {
        let other = packages
            .iter()
            .filter(|(id, _)| **id != peer.identifier)
            .map(|(id, p)| (*id, p.clone()))
            .collect::<BTreeMap<_, _>>();
        peer.send(&json!({"op":"Part2", "session":session, "packages":other}))?;
    }
    let r2 = peers
        .iter_mut()
        .map(Peer::receive)
        .collect::<Result<Vec<_>>>()?;
    let outgoing = r2
        .iter()
        .map(|reply| identifier_map(&accepted(reply)?["packages"]))
        .collect::<Result<Vec<_>>>()?;
    for peer in &mut peers {
        let mut incoming = BTreeMap::new();
        for sender in 1..=4u16 {
            if sender != peer.identifier {
                incoming.insert(
                    sender,
                    outgoing[usize::from(sender - 1)][&peer.identifier].clone(),
                );
            }
        }
        peer.send(&json!({"op":"Part3", "session":session, "packages":incoming}))?;
    }
    let r3 = peers
        .iter_mut()
        .map(Peer::receive)
        .collect::<Result<Vec<_>>>()?;
    let public_hex = text(accepted(&r3[0])?, "public_package")?;
    if r3.iter().any(|reply| {
        accepted(reply)
            .ok()
            .and_then(|value| value["public_package"].as_str())
            != Some(public_hex)
    }) {
        return Err("DKG public packages disagree".into());
    }
    let public = frost::keys::PublicKeyPackage::deserialize(&bytes(public_hex)?)
        .map_err(|e| format!("{e:?}"))?;
    let transcript = json!({"session":session, "n":4,"threshold":3,"participant_pids":r1.iter().map(|r|r["pid"].clone()).collect::<Vec<_>>(),"round1_public_packages":packages,"round1_delivery_bytes":packages.values().map(|p|p.len()/2*3).sum::<usize>(),"round2_confidential_delivery_bytes":outgoing.iter().flat_map(|map|map.values()).map(|p|p.len()/2).sum::<usize>(),"round_participant_elapsed_ns":[r1.iter().map(|r|r["elapsed_ns"].clone()).collect::<Vec<_>>(),r2.iter().map(|r|r["elapsed_ns"].clone()).collect::<Vec<_>>(),r3.iter().map(|r|r["elapsed_ns"].clone()).collect::<Vec<_>>()],"public_package":public_hex,"elapsed_ns":started.elapsed().as_nanos().to_string()});
    Ok(Generated {
        peers,
        public,
        session,
        transcript,
    })
}
struct Signed {
    package: frost::SigningPackage,
    shares: BTreeMap<frost::Identifier, frost::round2::SignatureShare>,
    transcript: Value,
}
fn sign_round(
    group: &mut Generated,
    selected: &[u16],
    message: &[u8],
    nonce_id: &str,
) -> Result<Signed> {
    let started = Instant::now();
    for index in selected {
        group.peers[usize::from(*index - 1)].send(
            &json!({"op":"Commit","session":group.session,"nonce":nonce_id,"message":hex(message)}),
        )?;
    }
    let mut commits = BTreeMap::new();
    let mut costs = Vec::new();
    for index in selected {
        let reply = group.peers[usize::from(*index - 1)].receive()?;
        let encoded = text(accepted(&reply)?, "commitments")?;
        commits.insert(
            id(*index)?,
            frost::round1::SigningCommitments::deserialize(&bytes(encoded)?)
                .map_err(|e| format!("{e:?}"))?,
        );
        costs.push(reply["elapsed_ns"].clone());
    }
    let package = frost::SigningPackage::new(commits, message);
    let encoded = hex(&package.serialize().map_err(|e| format!("{e:?}"))?);
    for index in selected {
        group.peers[usize::from(*index - 1)].send(
            &json!({"op":"Sign","session":group.session,"nonce":nonce_id,"package":encoded}),
        )?;
    }
    let mut shares = BTreeMap::new();
    let mut public_shares = BTreeMap::new();
    let mut sign_costs = Vec::new();
    for index in selected {
        let reply = group.peers[usize::from(*index - 1)].receive()?;
        let encoded = text(accepted(&reply)?, "share")?;
        shares.insert(
            id(*index)?,
            frost::round2::SignatureShare::deserialize(&bytes(encoded)?)
                .map_err(|e| format!("{e:?}"))?,
        );
        public_shares.insert(*index, encoded.to_string());
        sign_costs.push(reply["elapsed_ns"].clone());
    }
    let aggregate_started = Instant::now();
    let signature =
        frost::aggregate(&package, &shares, &group.public).map_err(|e| format!("{e:?}"))?;
    let aggregate_ns = aggregate_started.elapsed().as_nanos();
    let verify_started = Instant::now();
    group
        .public
        .verifying_key()
        .verify(message, &signature)
        .map_err(|e| format!("{e:?}"))?;
    let transcript = json!({"participants":selected,"nonce_id":nonce_id,"signing_package":encoded,"signature_shares":public_shares,"signature":hex(&signature.serialize().map_err(|e| format!("{e:?}"))?),"nonce_participant_elapsed_ns":costs,"share_participant_elapsed_ns":sign_costs,"aggregate_ns":aggregate_ns.to_string(),"frost_verify_ns":verify_started.elapsed().as_nanos().to_string(),"elapsed_ns":started.elapsed().as_nanos().to_string()});
    Ok(Signed {
        package,
        shares,
        transcript,
    })
}
fn campaign(input: &str) -> Result<Value> {
    let input: Value = serde_json::from_slice(&fs::read(input).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut group = dkg()?;
    let mut checks = Vec::new();
    let key = hex(&group
        .public
        .verifying_key()
        .serialize()
        .map_err(|e| format!("{e:?}"))?);
    let mut rounds = Vec::new();
    let mut previous: Option<Signed> = None;
    for (round, selected) in [[1u16, 2, 3], [1, 2, 4], [1, 3, 4], [2, 3, 4]]
        .iter()
        .enumerate()
    {
        let participants = selected
            .iter()
            .map(|id| input["participants"][usize::from(*id - 1)].clone())
            .collect::<Vec<_>>();
        let envelope = json!({"domain":"aether.quorum-threshold-vote-prototype/1","body":input["body"],"groupSigner":format!("frost-ed25519:{key}"),"dkgSession":group.session,"ciphersuite":"FROST-ED25519-SHA512-v1","threshold":3,"participants":participants});
        let message = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
        let nonce = format!("signing-{round}");
        let signed = sign_round(&mut group, selected, &message, &nonce)?;
        let mut fewer = signed.shares.clone();
        fewer.pop_first();
        let rejected = frost::aggregate(&signed.package, &fewer, &group.public).is_err();
        if !rejected {
            return Err("two shares unexpectedly aggregated".into());
        }
        checks.push(
            json!({"scenario":"two shares for selected three","round":round,"rejected":true}),
        );
        if let Some(prior) = &previous {
            let mut stale = signed.shares.clone();
            let overlap = *signed
                .shares
                .keys()
                .find(|id| prior.shares.contains_key(id))
                .unwrap();
            stale.insert(overlap, prior.shares[&overlap]);
            let result = frost::aggregate(&signed.package, &stale, &group.public);
            if result.is_ok() {
                return Err("stale share accepted".into());
            }
            checks.push(json!({"scenario":"share from preceding message/nonce set","round":round,"rejected":true,"error":format!("{:?}",result.err().unwrap())}));
        }
        require_rejection(group.peers[usize::from(selected[0]-1)].request(json!({"op":"Sign","session":group.session,"nonce":nonce,"package":hex(&signed.package.serialize().map_err(|e| format!("{e:?}"))?)}))?,"consumed nonce reuse",&mut checks)?;
        require_rejection(group.peers[usize::from(selected[0]-1)].request(json!({"op":"Commit","session":group.session,"nonce":nonce,"message":hex(&message)}))?,"nonce identity reuse",&mut checks)?;
        rounds.push(
            json!({"envelope":envelope,"message_hex":hex(&message),"transcript":signed.transcript}),
        );
        previous = Some(signed);
    }
    let malformed = frost::round2::SignatureShare::deserialize(&[255u8; 32]);
    if malformed.is_ok() {
        return Err("noncanonical scalar accepted".into());
    }
    checks.push(json!({"scenario":"noncanonical signature share scalar","rejected":true,"error":format!("{:?}",malformed.err().unwrap())}));
    require_rejection(group.peers[0].request(json!({"op":"Commit","session":"00000000000000000000000000000000","nonce":"stale-session","message":"01"}))?,"stale DKG session",&mut checks)?;
    accepted(&group.peers[0].request(
        json!({"op":"Commit","session":group.session,"nonce":"malformed-package","message":"01"}),
    )?)?;
    require_rejection(
        group.peers[0].request(
            json!({"op":"Sign","session":group.session,"nonce":"malformed-package","package":"ff"}),
        )?,
        "malformed signing package burns nonce",
        &mut checks,
    )?;
    require_rejection(
        group.peers[0].request(
            json!({"op":"Sign","session":group.session,"nonce":"malformed-package","package":"ff"}),
        )?,
        "failed-attempt nonce cannot be reused",
        &mut checks,
    )?;
    Ok(
        json!({"format":"aether.frost-prototype-result/1","crate":"frost-ed25519=3.0.0","group_public_key":key,"dkg":group.transcript,"rounds":rounds,"rejections":checks}),
    )
}
fn main() {
    let args: Vec<String> = env::args().collect();
    let result = if args.get(1).map(String::as_str) == Some("worker") {
        args.get(2)
            .and_then(|s| s.parse().ok())
            .ok_or("missing participant".into())
            .and_then(worker)
    } else {
        args.get(1)
            .ok_or("missing public input path".into())
            .and_then(|path| campaign(path))
            .map(|result| println!("{result}"))
    };
    if let Err(error) = result {
        eprintln!("prototype failed: {error}");
        std::process::exit(1);
    }
}
