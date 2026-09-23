//! Secret packages stay in participant memory. Local IPC is a trusted
//! simulation of ZF's DKG channels, not secure broadcast. No secret persistence.
use ed25519_dalek::{Signer, SigningKey};
use frost_ristretto255 as frost;
use rand_core::OsRng;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
pub mod verify;

pub type Result<T> = std::result::Result<T, String>;
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
pub fn bytes(value: &str) -> Result<Vec<u8>> {
    if value.len() > 128 * 1024
        || value.len() % 2 != 0
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("noncanonical/oversized hex".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).map_err(|_| "invalid hex".into()))
        .collect()
}
pub fn id(value: u16) -> Result<frost::Identifier> {
    if !(1..=4).contains(&value) {
        return Err("participant outside fixed 4-person group".into());
    }
    value.try_into().map_err(|e| format!("{e:?}"))
}
fn err(value: impl std::fmt::Debug) -> String {
    format!("{value:?}")
}
// Internally tagged serde enums buffer JSON map keys as strings. Decode and
// validate these explicitly; do not collapse duplicate participant entries.
fn package_map<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> std::result::Result<BTreeMap<u16, String>, D::Error> {
    struct Packages;
    impl<'de> serde::de::Visitor<'de> for Packages {
        type Value = BTreeMap<u16, String>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("canonical participant package map")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> std::result::Result<Self::Value, M::Error> {
            let mut result = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, String>()? {
                let identifier: u16 = key
                    .parse()
                    .map_err(|_| serde::de::Error::custom("invalid participant map key"))?;
                if !(1..=4).contains(&identifier)
                    || identifier.to_string() != key
                    || result.insert(identifier, value).is_some()
                {
                    return Err(serde::de::Error::custom(
                        "duplicate/noncanonical participant map key",
                    ));
                }
            }
            Ok(result)
        }
    }
    decoder.deserialize_map(Packages)
}
#[derive(Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum Request {
    Begin {
        session: String,
    },
    Part2 {
        session: String,
        #[serde(deserialize_with = "package_map")]
        packages: BTreeMap<u16, String>,
    },
    Part3 {
        session: String,
        #[serde(deserialize_with = "package_map")]
        packages: BTreeMap<u16, String>,
    },
    Commit {
        session: String,
        nonce: String,
        message: String,
    },
    Sign {
        session: String,
        nonce: String,
        package: String,
    },
    Attest {
        session: String,
        nonce: String,
        transcript: Value,
    },
}
struct PendingNonce {
    message: Vec<u8>,
    nonces: frost::round1::SigningNonces,
    commitments: frost::round1::SigningCommitments,
}
struct Emitted {
    package: String,
    share: String,
}
pub struct Participant {
    identifier: u16,
    session: Option<String>,
    round1: Option<frost::keys::dkg::round1::SecretPackage>,
    round2: Option<frost::keys::dkg::round2::SecretPackage>,
    peers: BTreeMap<frost::Identifier, frost::keys::dkg::round1::Package>,
    key: Option<frost::keys::KeyPackage>,
    public: Option<frost::keys::PublicKeyPackage>,
    identity: SigningKey,
    emitted: BTreeMap<String, Emitted>,
    pending: BTreeMap<String, PendingNonce>,
    seen: BTreeSet<String>,
}
impl Participant {
    pub fn new(identifier: u16) -> Result<Self> {
        id(identifier)?;
        Ok(Self {
            identifier,
            session: None,
            round1: None,
            round2: None,
            peers: BTreeMap::new(),
            key: None,
            public: None,
            // Public fixture seed, not an enrolled production identity key.
            identity: SigningKey::from_bytes(&[identifier as u8; 32]),
            emitted: BTreeMap::new(),
            pending: BTreeMap::new(),
            seen: BTreeSet::new(),
        })
    }
    fn session(&self, value: &str) -> Result<()> {
        if self.session.as_deref() != Some(value) {
            return Err("stale DKG/signing session".into());
        }
        Ok(())
    }
    fn peers(&self, packages: &BTreeMap<u16, String>) -> Result<()> {
        if packages.len() != 3
            || packages
                .keys()
                .any(|key| *key == self.identifier || !(1..=4).contains(key))
        {
            return Err("missing, duplicate or unknown DKG peer".into());
        }
        Ok(())
    }
    pub fn handle(&mut self, request: Request) -> Result<Value> {
        match request {
            Request::Begin { session } => {
                if self.session.is_some() || session.len() != 32 || bytes(&session)?.len() != 16 {
                    return Err("DKG already initialized or invalid session".into());
                }
                let (secret, package) =
                    frost::keys::dkg::part1(id(self.identifier)?, 4, 3, &mut OsRng).map_err(err)?;
                self.round1 = Some(secret);
                self.session = Some(session);
                Ok(json!({"package": hex(&package.serialize().map_err(err)?)}))
            }
            Request::Part2 { session, packages } => {
                self.session(&session)?;
                self.peers(&packages)?;
                let parsed = packages
                    .iter()
                    .map(|(peer, package)| {
                        Ok((
                            id(*peer)?,
                            frost::keys::dkg::round1::Package::deserialize(&bytes(package)?)
                                .map_err(err)?,
                        ))
                    })
                    .collect::<Result<BTreeMap<_, _>>>()?;
                let secret = self
                    .round1
                    .take()
                    .ok_or("DKG round1 state unavailable/consumed")?;
                // Cryptographic failure consumes this attempt; restart DKG.
                let (secret2, outbound) = frost::keys::dkg::part2(secret, &parsed).map_err(err)?;
                self.round2 = Some(secret2);
                self.peers = parsed;
                let mut result = BTreeMap::new();
                for peer in 1..=4u16 {
                    if let Some(package) = outbound.get(&id(peer)?) {
                        result.insert(peer, hex(&package.serialize().map_err(err)?));
                    }
                }
                Ok(json!({"packages": result}))
            }
            Request::Part3 { session, packages } => {
                self.session(&session)?;
                self.peers(&packages)?;
                let parsed = packages
                    .iter()
                    .map(|(peer, package)| {
                        Ok((
                            id(*peer)?,
                            frost::keys::dkg::round2::Package::deserialize(&bytes(package)?)
                                .map_err(err)?,
                        ))
                    })
                    .collect::<Result<BTreeMap<_, _>>>()?;
                let secret = self
                    .round2
                    .take()
                    .ok_or("DKG round2 state unavailable/consumed")?;
                let (key, public) =
                    frost::keys::dkg::part3(&secret, &self.peers, &parsed).map_err(err)?;
                self.key = Some(key);
                self.public = Some(public.clone());
                self.peers.clear();
                let enrollment = json!({"domain":"aether.ristretto-group-enrollment/1","session":session,"participant":self.identifier,"n":4,"threshold":3,"public_package":hex(&public.serialize().map_err(err)?),"group_key":hex(&public.verifying_key().serialize().map_err(err)?)});
                let authentication = hex(&self
                    .identity
                    .sign(&serde_json::to_vec(&enrollment).map_err(err)?)
                    .to_bytes());
                Ok(
                    json!({"public_package": hex(&public.serialize().map_err(err)?), "group_key": hex(&public.verifying_key().serialize().map_err(err)?),"enrollment":enrollment,"authentication":authentication}),
                )
            }
            Request::Commit {
                session,
                nonce,
                message,
            } => {
                self.session(&session)?;
                if nonce.is_empty()
                    || nonce.len() > 64
                    || !nonce.is_ascii()
                    || self.seen.contains(&nonce)
                    || self.seen.len() >= 256
                {
                    return Err("duplicate/oversized/exhausted nonce identity".into());
                }
                let message = bytes(&message)?;
                if message.is_empty() || message.len() > 16 * 1024 {
                    return Err("signing message size".into());
                }
                let key = self.key.as_ref().ok_or("DKG not complete")?;
                let (nonces, commitments) = frost::round1::commit(key.signing_share(), &mut OsRng);
                self.seen.insert(nonce.clone());
                self.pending.insert(
                    nonce,
                    PendingNonce {
                        message,
                        nonces,
                        commitments,
                    },
                );
                Ok(json!({"commitments": hex(&commitments.serialize().map_err(err)?)}))
            }
            Request::Sign {
                session,
                nonce,
                package,
            } => {
                self.session(&session)?;
                // Burn before parsing/validation/signing. Borrowed library
                // nonces alone do not enforce single use.
                let pending = self
                    .pending
                    .remove(&nonce)
                    .ok_or("nonce absent or already consumed")?;
                let package = frost::SigningPackage::deserialize(&bytes(&package)?).map_err(err)?;
                if package.message() != &pending.message
                    || package.signing_commitments().len() < 3
                    || package.signing_commitments().len() > 4
                    || package.signing_commitments().get(&id(self.identifier)?)
                        != Some(&pending.commitments)
                    || package
                        .signing_commitments()
                        .keys()
                        .any(|peer| !(1..=4).any(|index| id(index).ok().as_ref() == Some(peer)))
                {
                    return Err("stale message, participant set or nonce commitment".into());
                }
                let share = frost::round2::sign(
                    &package,
                    &pending.nonces,
                    self.key.as_ref().ok_or("DKG not complete")?,
                )
                .map_err(err)?;
                let share = hex(&share.serialize());
                self.emitted.insert(
                    nonce,
                    Emitted {
                        package: hex(&package.serialize().map_err(err)?),
                        share: share.clone(),
                    },
                );
                Ok(json!({"share":share}))
            }
            Request::Attest {
                session,
                nonce,
                transcript,
            } => {
                self.session(&session)?;
                let emitted = self
                    .emitted
                    .get(&nonce)
                    .ok_or("no locally emitted signature share")?;
                if transcript["session"] != session
                    || transcript["nonce_id"] != nonce
                    || transcript["signing_package"] != emitted.package
                    || transcript["signature_shares"][self.identifier.to_string()] != emitted.share
                    || transcript["public_package"]
                        != hex(&self
                            .public
                            .as_ref()
                            .ok_or("DKG incomplete")?
                            .serialize()
                            .map_err(err)?)
                {
                    return Err("cannot attest a stale/foreign share transcript".into());
                }
                verify::verify_transcript(&transcript)?;
                let payload = json!({"domain":"aether.ristretto-participation/1","participant":self.identifier,"transcript":transcript});
                Ok(
                    json!({"participant":self.identifier,"authentication":hex(&self.identity.sign(&serde_json::to_vec(&payload).map_err(err)?).to_bytes())}),
                )
            }
        }
    }
}
