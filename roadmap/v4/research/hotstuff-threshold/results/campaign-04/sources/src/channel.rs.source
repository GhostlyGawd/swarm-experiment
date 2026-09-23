//! TLS 1.3 mutual authentication with exact enrolled leaf fingerprints.
//! Local host/key provisioning is trusted. No 0-RTT or session resumption.
use crate::{
    custody::{Context, Delivery, Store},
    digest, require, Result,
};
use rustls::{
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName},
    ClientConfig, ClientConnection, RootCertStore, ServerConfig, ServerConnection, StreamOwned,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub participant: u16,
    pub context: Context,
    pub directory: PathBuf,
    pub master: PathBuf,
    pub ca: PathBuf,
    pub certificate: PathBuf,
    pub private_key: PathBuf,
    pub members: BTreeMap<u16, String>,
}
fn material(
    config: &Config,
) -> Result<(
    Arc<RootCertStore>,
    Vec<CertificateDer<'static>>,
    PrivateKeyDer<'static>,
)> {
    let mut roots = RootCertStore::empty();
    roots.add(CertificateDer::from(fs::read(&config.ca)?))?;
    let certificate = vec![CertificateDer::from(fs::read(&config.certificate)?)];
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(fs::read(&config.private_key)?));
    Ok((Arc::new(roots), certificate, key))
}
fn frame(stream: &mut impl Read) -> Result<Vec<u8>> {
    let mut length = [0u8; 4];
    stream.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    require(
        length > 0 && length <= 64 * 1024,
        "TLS application frame bound",
    )?;
    let mut bytes = vec![0u8; length];
    stream.read_exact(&mut bytes)?;
    Ok(bytes)
}
fn write_frame(stream: &mut impl Write, bytes: &[u8]) -> Result<()> {
    require(
        !bytes.is_empty() && bytes.len() <= 64 * 1024,
        "TLS application frame bound",
    )?;
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(bytes)?;
    stream.flush()?;
    Ok(())
}
fn socket(address: &str) -> Result<TcpStream> {
    let stream = TcpStream::connect_timeout(&address.parse()?, Duration::from_secs(3))?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    Ok(stream)
}
pub fn send(config: &Config, to: u16, address: &str, delivery: &Delivery) -> Result<Value> {
    let (roots, certificates, key) = material(config)?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut client = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_root_certificates(roots)
        .with_client_auth_cert(certificates, key)?;
    client.resumption = rustls::client::Resumption::disabled();
    client.enable_early_data = false;
    let connection = ClientConnection::new(
        Arc::new(client),
        ServerName::try_from(format!("participant-{to}.test"))?,
    )?;
    let mut tls = StreamOwned::new(connection, socket(address)?);
    while tls.conn.is_handshaking() {
        tls.conn.complete_io(&mut tls.sock)?;
    }
    require(
        tls.conn.protocol_version() == Some(rustls::ProtocolVersion::TLSv1_3),
        "TLS version downgrade",
    )?;
    let certificate = tls
        .conn
        .peer_certificates()
        .and_then(|chain| chain.first())
        .ok_or("no server certificate")?;
    require(
        config.members.get(&to) == Some(&digest(certificate.as_ref())),
        "server identity pin mismatch",
    )?;
    write_frame(&mut tls, &serde_json::to_vec(delivery)?)?;
    let reply: Value = serde_json::from_slice(&frame(&mut tls)?)?;
    require(
        reply["ok"] == true,
        "authenticated recipient refused delivery",
    )?;
    Ok(reply)
}
pub fn start(config: Config, store: Store) -> Result<String> {
    let (roots, certificates, key) = material(&config)?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier =
        rustls::server::WebPkiClientVerifier::builder_with_provider(roots, provider.clone())
            .build()?;
    let mut server = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_client_cert_verifier(verifier)
        .with_single_cert(certificates, key)?;
    server.max_early_data_size = 0;
    server.send_tls13_tickets = 0;
    let server = Arc::new(server);
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?.to_string();
    std::thread::spawn(move || {
        for socket in listener.incoming().take(256) {
            let Ok(socket) = socket else {
                break;
            };
            let handle = || -> Result<()> {
                socket.set_read_timeout(Some(Duration::from_secs(3)))?;
                socket.set_write_timeout(Some(Duration::from_secs(3)))?;
                let mut tls = StreamOwned::new(ServerConnection::new(server.clone())?, socket);
                while tls.conn.is_handshaking() {
                    tls.conn.complete_io(&mut tls.sock)?;
                }
                require(
                    tls.conn.protocol_version() == Some(rustls::ProtocolVersion::TLSv1_3),
                    "TLS version downgrade",
                )?;
                let cert = tls
                    .conn
                    .peer_certificates()
                    .and_then(|chain| chain.first())
                    .ok_or("no client certificate")?;
                let pin = digest(cert.as_ref());
                let peer = *config
                    .members
                    .iter()
                    .find(|(_, fingerprint)| **fingerprint == pin)
                    .map(|(id, _)| id)
                    .ok_or("unrostered client certificate")?;
                let delivery: Delivery = serde_json::from_slice(&frame(&mut tls)?)?;
                let reply = match store.deliver(&delivery, peer) {
                    Ok(value) => json!({"ok":true,"tls":"TLSv1_3","peer":peer,"receipt":value}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                };
                write_frame(&mut tls, &serde_json::to_vec(&reply)?)?;
                Ok(())
            };
            let _ = handle();
        }
    });
    Ok(address)
}
