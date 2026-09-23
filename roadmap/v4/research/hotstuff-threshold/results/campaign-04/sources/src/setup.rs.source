use crate::{
    channel::Config,
    custody::{ensure, private_write, Context},
    digest, hex, require, Result,
};
use rcgen::{
    BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};
pub fn create(root: &Path, input: &Value) -> Result<Value> {
    require(!root.exists(), "fresh epoch directory required")?;
    ensure(root)?;
    let mut random = [0u8; 32];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| "OS randomness")?;
    let mut ca_params = CertificateParams::new(Vec::<String>::new())?;
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyCertSign,
    ];
    let ca_key = KeyPair::generate()?;
    let ca = ca_params.self_signed(&ca_key)?;
    let issuer = Issuer::new(ca_params, ca_key);
    let ca_path = root.join("ca.der");
    private_write(&ca_path, ca.der())?;
    let mut certificates = Vec::new();
    let mut secrets = Vec::new();
    let mut members = BTreeMap::new();
    let mut public_certs = BTreeMap::new();
    for id in 1..=4u16 {
        let key = KeyPair::generate()?;
        let mut params = CertificateParams::new(vec![format!("participant-{id}.test")])?;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![
            ExtendedKeyUsagePurpose::ClientAuth,
            ExtendedKeyUsagePurpose::ServerAuth,
        ];
        let cert = params.signed_by(&key, &issuer)?;
        let path = root.join(format!("participant-{id}.der"));
        private_write(&path, cert.der())?;
        let secret = root.join(format!("participant-{id}.key"));
        private_write(&secret, &key.serialize_der())?;
        members.insert(id, digest(cert.der()));
        public_certs.insert(id, hex(cert.der()));
        certificates.push(path);
        secrets.push(secret);
    }
    let string = |key: &str| {
        input[key]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| format!("missing setup {key}"))
    };
    let context = Context {
        format: "aether.hotstuff-custody-context/1".into(),
        group: hex(&random),
        session: hex(&random[..16]),
        repository: string("repository")?,
        membership_epoch: string("membershipEpoch")?,
        policy_epoch: string("policyEpoch")?,
        roster: digest(&serde_json::to_vec(&members)?),
        vote_roster: string("voteRoster")?,
        vote_ids: serde_json::from_value(input["voteIds"].clone())?,
        vote_public_keys: serde_json::from_value(input["votePublicKeys"].clone())?,
    };
    let mut paths = Vec::new();
    for id in 1..=4u16 {
        let home = root.join(format!("node-{id}"));
        ensure(&home)?;
        let master = home.join("master.key");
        let mut key = [0u8; 32];
        SystemRandom::new()
            .fill(&mut key)
            .map_err(|_| "OS randomness")?;
        private_write(&master, &key)?;
        let config = Config {
            participant: id,
            context: context.clone(),
            directory: home.join("custody"),
            master,
            ca: ca_path.clone(),
            certificate: certificates[usize::from(id - 1)].clone(),
            private_key: secrets[usize::from(id - 1)].clone(),
            members: members.clone(),
        };
        let path = home.join("custody-config.json");
        private_write(&path, &serde_json::to_vec(&config)?)?;
        paths.push(path);
    }
    Ok(json!({"configs":paths,"context":context,"certificates":public_certs,"ca":hex(ca.der())}))
}
