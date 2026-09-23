//! Encrypted same-host research custody. Filesystem/master-key trust and whole
//! directory rollback are explicitly outside this profile. Public burn markers
//! protect against a stale encrypted-state file and process death mid-signing.
use crate::{bytes, digest, frost_error, hex, require, Result};
use frost_ristretto255 as frost;
use fs2::FileExt;
use rand_core::OsRng;
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Context {
    pub format: String,
    pub group: String,
    pub session: String,
    pub repository: String,
    pub membership_epoch: String,
    pub policy_epoch: String,
    pub roster: String,
    pub vote_roster: String,
    pub vote_ids: Vec<String>,
    pub vote_public_keys: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Delivery {
    pub context: Context,
    pub from: u16,
    pub to: u16,
    pub phase: String,
    pub payload: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NonceRecord {
    subject: String,
    commitments: String,
    nonces: Option<String>,
    package: Option<String>,
    share: Option<String>,
    burned: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    format: String,
    context: Context,
    participant: u16,
    revision: u64,
    round1_secret: Option<String>,
    round1_public: Option<String>,
    round2_secret: Option<String>,
    round2_out: BTreeMap<u16, String>,
    inbox: BTreeMap<String, String>,
    deliveries: BTreeMap<String, String>,
    key: Option<String>,
    public: Option<String>,
    nonces: BTreeMap<String, NonceRecord>,
    vote_slots: BTreeMap<String, String>,
    retired: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Encrypted {
    format: String,
    context: String,
    participant: u16,
    revision: u64,
    nonce: String,
    ciphertext: String,
}
#[derive(Clone)]
pub struct Store {
    directory: PathBuf,
    context: Context,
    participant: u16,
    key: [u8; 32],
}
fn id(value: u16) -> Result<frost::Identifier> {
    require((1..=4).contains(&value), "unknown participant")?;
    value.try_into().map_err(frost_error)
}
pub fn sync(directory: &Path) -> Result<()> {
    File::open(directory)?.sync_all()?;
    Ok(())
}
pub fn ensure(directory: &Path) -> Result<()> {
    if directory.exists() {
        return Ok(());
    }
    if let Some(parent) = directory.parent() {
        ensure(parent)?;
    }
    match fs::create_dir(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    };
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    sync(directory)?;
    if let Some(parent) = directory.parent() {
        sync(parent)?;
    }
    Ok(())
}
pub fn private_write(path: &Path, data: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(data)?;
    file.sync_all()?;
    sync(path.parent().unwrap())
}
fn fault(point: &str) {
    if std::env::var("AETHER_CUSTODY_FAULT").ok().as_deref() == Some(point) {
        // Test-only crash injection, no pointers or shared memory involved.
        unsafe {
            libc::kill(libc::getpid(), libc::SIGKILL);
        }
        std::process::abort();
    }
}
impl Store {
    pub fn open(
        directory: PathBuf,
        context: Context,
        participant: u16,
        key_path: &Path,
    ) -> Result<Self> {
        require(
            context.format == "aether.hotstuff-custody-context/1"
                && bytes(&context.session)?.len() == 16
                && bytes(&context.group)?.len() == 32
                && bytes(&context.roster)?.len() == 32
                && context.vote_ids.len() == 4
                && context.vote_public_keys.len() == 4
                && context
                    .vote_public_keys
                    .iter()
                    .all(|key| bytes(key).map(|key| key.len() == 32).unwrap_or(false)),
            "invalid custody context",
        )?;
        id(participant)?;
        require(
            fs::metadata(key_path)?.permissions().mode() & 0o077 == 0,
            "custody master key permissions",
        )?;
        let key: [u8; 32] = fs::read(key_path)?
            .try_into()
            .map_err(|_| "custody master key length")?;
        ensure(&directory)?;
        let store = Self {
            directory,
            context,
            participant,
            key,
        };
        store.locked(|| {
            let seal = store.directory.join("initialized");
            let marker = store.directory.join("initializing");
            let identity = store.binding()?;
            if seal.exists() {
                require(
                    fs::read(&seal)? == identity,
                    "custody initialization binding",
                )?;
                store.read()?;
                if marker.exists() {
                    fs::remove_file(&marker)?;
                    sync(&store.directory)?;
                }
                return Ok(());
            }
            require(
                !store.file().exists() || marker.exists(),
                "missing custody completion receipt",
            )?;
            if marker.exists() {
                require(
                    fs::read(&marker)? == identity,
                    "custody initialization marker",
                )?;
            } else {
                private_write(&marker, &identity)?;
            }
            if store.file().exists() {
                require(store.read()?.revision == 0, "cannot reset nonempty custody")?;
            } else {
                store.save(&State {
                    format: "aether.hotstuff-custody-state/1".into(),
                    context: store.context.clone(),
                    participant,
                    revision: 0,
                    round1_secret: None,
                    round1_public: None,
                    round2_secret: None,
                    round2_out: BTreeMap::new(),
                    inbox: BTreeMap::new(),
                    deliveries: BTreeMap::new(),
                    key: None,
                    public: None,
                    nonces: BTreeMap::new(),
                    vote_slots: BTreeMap::new(),
                    retired: None,
                })?;
            }
            private_write(&seal, &identity)?;
            fs::remove_file(marker)?;
            sync(&store.directory)
        })?;
        Ok(store)
    }
    fn file(&self) -> PathBuf {
        self.directory.join("custody.enc")
    }
    fn binding(&self) -> Result<Vec<u8>> {
        Ok(serde_json::to_vec(
            &json!({"context":self.context,"participant":self.participant}),
        )?)
    }
    fn locked<T>(&self, action: impl FnOnce() -> Result<T>) -> Result<T> {
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(self.directory.join("lock"))?;
        sync(&self.directory)?;
        lock.lock_exclusive()?;
        let result = action();
        FileExt::unlock(&lock)?;
        result
    }
    fn aead(&self) -> Result<aead::LessSafeKey> {
        Ok(aead::LessSafeKey::new(
            aead::UnboundKey::new(&aead::CHACHA20_POLY1305, &self.key).map_err(|_| "AEAD key")?,
        ))
    }
    fn read(&self) -> Result<State> {
        require(
            fs::metadata(self.file())?.len() <= 2 * 1024 * 1024,
            "custody file size",
        )?;
        let record: Encrypted = serde_json::from_slice(&fs::read(self.file())?)?;
        require(
            record.format == "aether.custody-aead/1"
                && record.context == digest(&self.binding()?)
                && record.participant == self.participant
                && record.revision <= 4096,
            "custody state context/revision",
        )?;
        let aad = serde_json::to_vec(
            &json!({"context":record.context,"participant":record.participant,"revision":record.revision}),
        )?;
        let nonce: [u8; 12] = bytes(&record.nonce)?
            .try_into()
            .map_err(|_| "AEAD nonce length")?;
        let mut encrypted = bytes(&record.ciphertext)?;
        let plaintext = self
            .aead()?
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(aad),
                &mut encrypted,
            )
            .map_err(|_| "custody authentication failed")?;
        let state: State = serde_json::from_slice(plaintext)?;
        require(
            state.format == "aether.hotstuff-custody-state/1"
                && state.context == self.context
                && state.participant == self.participant
                && state.revision == record.revision
                && state.nonces.len() <= 128
                && state.deliveries.len() <= 64,
            "invalid custody state",
        )?;
        Ok(state)
    }
    fn save(&self, state: &State) -> Result<()> {
        require(state.revision <= 4096, "custody revision limit")?;
        let context = digest(&self.binding()?);
        let aad = serde_json::to_vec(
            &json!({"context":context,"participant":self.participant,"revision":state.revision}),
        )?;
        let mut nonce = [0u8; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "OS randomness unavailable")?;
        let mut ciphertext = serde_json::to_vec(state)?;
        require(ciphertext.len() <= 512 * 1024, "custody plaintext limit")?;
        self.aead()?
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(aad),
                &mut ciphertext,
            )
            .map_err(|_| "custody encryption failed")?;
        let record = Encrypted {
            format: "aether.custody-aead/1".into(),
            context,
            participant: self.participant,
            revision: state.revision,
            nonce: hex(&nonce),
            ciphertext: hex(&ciphertext),
        };
        let temporary = self.directory.join(format!(".state-{}", hex(&nonce)));
        private_write(&temporary, &serde_json::to_vec(&record)?)?;
        fs::rename(&temporary, self.file())?;
        sync(&self.directory)
    }
    fn update<T>(&self, action: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
        self.locked(|| {
            let mut state = self.read()?;
            let before = serde_json::to_vec(&state)?;
            let result = action(&mut state)?;
            if serde_json::to_vec(&state)? == before {
                return Ok(result);
            }
            state.revision += 1;
            self.save(&state)?;
            Ok(result)
        })
    }
    pub fn start(&self) -> Result<Value> {
        self.update(|state| {
            if let Some(public) = &state.round1_public {
                return Ok(json!({"digest":digest(&bytes(public)?)}));
            }
            require(state.key.is_none(), "DKG already complete")?;
            let (secret, public) = frost::keys::dkg::part1(id(self.participant)?, 4, 3, &mut OsRng)
                .map_err(frost_error)?;
            state.round1_secret = Some(hex(&secret.serialize().map_err(frost_error)?));
            let encoded = hex(&public.serialize().map_err(frost_error)?);
            let result = json!({"digest":digest(&bytes(&encoded)?)});
            state.round1_public = Some(encoded);
            Ok(result)
        })
    }
    fn agreement(&self, state: &State) -> Result<BTreeMap<u16, String>> {
        let mut map = BTreeMap::new();
        for sender in 1..=4 {
            let public = if sender == self.participant {
                state.round1_public.as_ref()
            } else {
                state.inbox.get(&format!("r1/{sender}"))
            }
            .ok_or("withheld DKG round1 package")?;
            map.insert(sender, digest(&bytes(public)?));
        }
        Ok(map)
    }
    pub fn outgoing(&self, phase: &str, to: u16) -> Result<Delivery> {
        id(to)?;
        self.locked(|| {
            let state = self.read()?;
            let payload = match phase {
                "r1" => state.round1_public.clone().ok_or("DKG not begun")?,
                "agreement" => hex(&serde_json::to_vec(&self.agreement(&state)?)?),
                "r2" => state
                    .round2_out
                    .get(&to)
                    .cloned()
                    .ok_or("DKG round2 not ready")?,
                _ => return Err("unknown DKG delivery phase".into()),
            };
            Ok(Delivery {
                context: self.context.clone(),
                from: self.participant,
                to,
                phase: phase.into(),
                payload,
            })
        })
    }
    pub fn deliver(&self, delivery: &Delivery, authenticated: u16) -> Result<Value> {
        require(
            delivery.context == self.context
                && delivery.to == self.participant
                && delivery.from == authenticated
                && delivery.from != self.participant,
            "authenticated delivery context/sender/recipient mismatch",
        )?;
        id(authenticated)?;
        require(
            ["r1", "agreement", "r2", "probe"].contains(&delivery.phase.as_str()),
            "unknown delivery phase",
        )?;
        let payload = bytes(&delivery.payload)?;
        require(payload.len() <= 16 * 1024, "delivery byte limit")?;
        self.update(|state| {
            let slot = format!("{}/{}", delivery.phase, delivery.from);
            let hash = digest(&serde_json::to_vec(delivery)?);
            if let Some(prior) = state.deliveries.get(&slot) {
                require(prior == &hash, "replayed/equivocating delivery slot")?;
                return Ok(json!({"duplicate":true,"digest":hash}));
            }
            require(state.deliveries.len() < 64, "delivery journal full")?;
            state.deliveries.insert(slot.clone(), hash.clone());
            state.inbox.insert(slot, delivery.payload.clone());
            Ok(json!({"duplicate":false,"digest":hash}))
        })
    }
    pub fn part2(&self) -> Result<Value> {
        self.update(|state| {
            if state.round2_secret.is_some() {
                return Ok(json!({"ready":true}));
            }
            let agreement = self.agreement(state)?;
            for sender in 1..=4 {
                if sender != self.participant {
                    let encoded = state
                        .inbox
                        .get(&format!("agreement/{sender}"))
                        .ok_or("withheld authenticated round1 agreement")?;
                    let proposed: BTreeMap<u16, String> = serde_json::from_slice(&bytes(encoded)?)?;
                    require(
                        proposed == agreement,
                        "inconsistent authenticated DKG broadcast",
                    )?;
                }
            }
            let secret = frost::keys::dkg::round1::SecretPackage::deserialize(&bytes(
                state.round1_secret.as_ref().ok_or("missing DKG secret")?,
            )?)
            .map_err(frost_error)?;
            let mut peers = BTreeMap::new();
            for sender in 1..=4 {
                if sender != self.participant {
                    peers.insert(
                        id(sender)?,
                        frost::keys::dkg::round1::Package::deserialize(&bytes(
                            &state.inbox[&format!("r1/{sender}")],
                        )?)
                        .map_err(frost_error)?,
                    );
                }
            }
            let (secret, out) = frost::keys::dkg::part2(secret, &peers).map_err(frost_error)?;
            state.round1_secret = None;
            state.round2_secret = Some(hex(&secret.serialize().map_err(frost_error)?));
            for receiver in 1..=4 {
                if receiver != self.participant {
                    state.round2_out.insert(
                        receiver,
                        hex(&out[&id(receiver)?].serialize().map_err(frost_error)?),
                    );
                }
            }
            Ok(json!({"ready":true}))
        })
    }
    pub fn part3(&self) -> Result<Value> {
        self.update(|state| {
            if let Some(public) = &state.public {
                return Ok(json!({"public_package":public}));
            }
            let secret = frost::keys::dkg::round2::SecretPackage::deserialize(&bytes(
                state
                    .round2_secret
                    .as_ref()
                    .ok_or("missing DKG round2 state")?,
            )?)
            .map_err(frost_error)?;
            let mut r1 = BTreeMap::new();
            let mut r2 = BTreeMap::new();
            for sender in 1..=4 {
                if sender != self.participant {
                    r1.insert(
                        id(sender)?,
                        frost::keys::dkg::round1::Package::deserialize(&bytes(
                            state
                                .inbox
                                .get(&format!("r1/{sender}"))
                                .ok_or("missing round1")?,
                        )?)
                        .map_err(frost_error)?,
                    );
                    r2.insert(
                        id(sender)?,
                        frost::keys::dkg::round2::Package::deserialize(&bytes(
                            state
                                .inbox
                                .get(&format!("r2/{sender}"))
                                .ok_or("withheld private DKG package")?,
                        )?)
                        .map_err(frost_error)?,
                    );
                }
            }
            let (key, public) = frost::keys::dkg::part3(&secret, &r1, &r2).map_err(frost_error)?;
            let public = hex(&public.serialize().map_err(frost_error)?);
            state.key = Some(hex(&key.serialize().map_err(frost_error)?));
            state.public = Some(public.clone());
            state.round2_secret = None;
            state.round2_out.clear();
            state.inbox.clear();
            Ok(json!({"public_package":public}))
        })
    }
    fn active(&self, state: &State) -> Result<()> {
        require(
            state.retired.is_none() && !self.directory.join("retired").exists(),
            "membership epoch retired",
        )
    }
    pub fn verify(&self, proof: &Value) -> Result<Value> {
        self.locked(|| {
            let state = self.read()?;
            crate::proof::verify(
                &self.context,
                state.public.as_deref().ok_or("DKG incomplete")?,
                proof,
            )
        })
    }
    pub fn retire(&self, decision: &str) -> Result<Value> {
        require(
            !decision.is_empty() && decision.len() <= 256 && decision.is_ascii(),
            "retirement decision bound",
        )?;
        self.locked(|| {
            let marker = self.directory.join("retired");
            if marker.exists() {
                require(
                    fs::read(&marker)? == decision.as_bytes(),
                    "retirement decision conflict",
                )?;
            } else {
                private_write(&marker, decision.as_bytes())?;
            }
            fault("after-retirement-marker");
            let mut state = self.read()?;
            state.retired = Some(decision.into());
            state.key = None;
            for record in state.nonces.values_mut() {
                record.nonces = None;
                record.burned = true;
            }
            state.revision += 1;
            self.save(&state)?;
            Ok(json!({"retired":decision}))
        })
    }
    pub fn reserve(&self, nonce: &str, message: &str, authorization: &Value) -> Result<Value> {
        require(
            !nonce.is_empty() && nonce.len() <= 64 && nonce.is_ascii(),
            "nonce identity bound",
        )?;
        self.update(|state| {
            self.active(state)?;
            let vote = crate::proof::subject(
                &self.context,
                state.public.as_deref().ok_or("DKG incomplete")?,
                message,
            )?;
            crate::proof::authorize(&self.context, self.participant, &vote, authorization)?;
            let slot = format!(
                "{}/{}",
                vote["view"].as_str().unwrap(),
                vote["phase"].as_str().unwrap()
            );
            let identity = digest(&serde_json::to_vec(&vote)?);
            if let Some(prior) = state.vote_slots.get(&slot) {
                require(prior == &identity, "custody refuses conflicting phase vote")?;
            } else {
                require(state.vote_slots.len() < 1024, "vote custody slots full")?;
                state.vote_slots.insert(slot, identity);
            }
            if let Some(prior) = state.nonces.get(nonce) {
                require(prior.subject == message, "nonce subject conflict")?;
                require(
                    !prior.burned && !self.burn(nonce).exists(),
                    "nonce already consumed",
                )?;
                return Ok(json!({"commitments":prior.commitments}));
            }
            require(state.nonces.len() < 128, "nonce custody full")?;
            let key = frost::keys::KeyPackage::deserialize(&bytes(state.key.as_ref().unwrap())?)
                .map_err(frost_error)?;
            let (secret, public) = frost::round1::commit(key.signing_share(), &mut OsRng);
            let commitments = hex(&public.serialize().map_err(frost_error)?);
            state.nonces.insert(
                nonce.into(),
                NonceRecord {
                    subject: message.into(),
                    commitments: commitments.clone(),
                    nonces: Some(hex(&secret.serialize().map_err(frost_error)?)),
                    package: None,
                    share: None,
                    burned: false,
                },
            );
            Ok(json!({"commitments":commitments}))
        })
    }
    fn burn(&self, nonce: &str) -> PathBuf {
        self.directory
            .join(format!("burn-{}", digest(nonce.as_bytes())))
    }
    pub fn sign(&self, nonce: &str, package: &str) -> Result<Value> {
        self.locked(||{let mut state=self.read()?;self.active(&state)?;let prior=state.nonces.get(nonce).cloned().ok_or("nonce absent")?;if let Some(share)=prior.share{require(prior.package.as_deref()==Some(package),"signed receipt package conflict")?;return Ok(json!({"share":share,"cached":true}));}require(!prior.burned&&!self.burn(nonce).exists(),"nonce consumed without receipt; start fresh signing round")?;
        private_write(&self.burn(nonce),digest(&serde_json::to_vec(&json!({"context":self.context,"participant":self.participant,"nonce":nonce,"subject":prior.subject}))?).as_bytes())?;fault("after-burn-marker");
        let record=state.nonces.get_mut(nonce).unwrap();record.burned=true;record.nonces=None;record.package=Some(package.into());state.revision+=1;self.save(&state)?;fault("after-burn-state");
        let public=frost::SigningPackage::deserialize(&bytes(package)?).map_err(frost_error)?;require(public.serialize().map_err(frost_error)?==bytes(package)?&&public.message()==&bytes(&prior.subject)?&&public.signing_commitments().len()>=3&&public.signing_commitments().len()<=4&&public.signing_commitments().keys().all(|peer|(1..=4).any(|index|id(index).ok().as_ref()==Some(peer))),"stale signing subject/participants")?;let nonces=frost::round1::SigningNonces::deserialize(&bytes(prior.nonces.as_ref().ok_or("missing reserved secret")?)?).map_err(frost_error)?;let expected=frost::round1::SigningCommitments::deserialize(&bytes(&prior.commitments)?).map_err(frost_error)?;require(public.signing_commitments().get(&id(self.participant)?)==Some(&expected),"nonce commitment mismatch")?;
        let key=frost::keys::KeyPackage::deserialize(&bytes(state.key.as_ref().ok_or("DKG incomplete")?)?).map_err(frost_error)?;let share=frost::round2::sign(&public,&nonces,&key).map_err(frost_error)?;fault("after-sign-before-receipt");let encoded=hex(&share.serialize());state.nonces.get_mut(nonce).unwrap().share=Some(encoded.clone());state.revision+=1;self.save(&state)?;fault("after-share-receipt");Ok(json!({"share":encoded,"cached":false}))})
    }
    pub fn status(&self) -> Result<Value> {
        self.locked(||{let state=self.read()?;Ok(json!({"participant":self.participant,"revision":state.revision,"ready":state.key.is_some(),"public_package":state.public,"retired":state.retired.or_else(||fs::read_to_string(self.directory.join("retired")).ok()),"vote_slots":state.vote_slots,"received":state.deliveries,"nonce_states":state.nonces.iter().map(|(id,record)|(id,json!({"burned":record.burned||self.burn(id).exists(),"receipt":record.share.is_some()}))).collect::<BTreeMap<_,_>>(),"encrypted_state_digest":digest(&fs::read(self.file())?)}))})
    }
}
