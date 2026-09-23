use aether_hotstuff_threshold_research::{
    channel::{self, Config},
    custody::{Delivery, Store},
    Result,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, Read, Write},
};
#[derive(Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
enum Command {
    Start,
    Send {
        phase: String,
        targets: BTreeMap<String, String>,
    },
    Raw {
        to: u16,
        address: String,
        delivery: Delivery,
    },
    Part2,
    Part3,
    Reserve {
        nonce: String,
        message: String,
        authorization: Value,
    },
    Sign {
        nonce: String,
        package: String,
    },
    Status,
    Verify {
        proof: Value,
    },
    Retire {
        decision: String,
    },
}
fn helper(mode: &str, args: &[String]) -> Result<()> {
    use aether_hotstuff_threshold_research::{bytes, custody::Context, frost_error, hex, proof};
    use frost_ristretto255 as frost;
    if mode == "setup" {
        let input: Value =
            serde_json::from_slice(&fs::read(args.get(2).ok_or("setup input required")?)?)?;
        println!(
            "{}",
            aether_hotstuff_threshold_research::setup::create(
                std::path::Path::new(args.get(3).ok_or("setup destination")?),
                &input
            )?
        );
        return Ok(());
    }
    let mut raw = String::new();
    std::io::stdin()
        .take(2 * 1024 * 1024)
        .read_to_string(&mut raw)?;
    let mut input: Value = serde_json::from_str(&raw)?;
    if mode == "public" {
        let public = frost::keys::PublicKeyPackage::deserialize(&bytes(
            input["publicPackage"].as_str().ok_or("public package")?,
        )?)
        .map_err(frost_error)?;
        println!(
            "{}",
            json!({"groupPublicKey":hex(&public.verifying_key().serialize().map_err(frost_error)?)})
        );
        return Ok(());
    }
    if mode == "package" {
        let mut commitments = BTreeMap::new();
        for (id, value) in input["commitments"].as_object().ok_or("commitment map")? {
            let id: frost::Identifier = id.parse::<u16>()?.try_into().map_err(frost_error)?;
            commitments.insert(
                id,
                frost::round1::SigningCommitments::deserialize(&bytes(
                    value.as_str().ok_or("commitment bytes")?,
                )?)
                .map_err(frost_error)?,
            );
        }
        let package = frost::SigningPackage::new(
            commitments,
            &bytes(input["message"].as_str().ok_or("message")?)?,
        );
        println!(
            "{}",
            json!({"package":hex(&package.serialize().map_err(frost_error)?)})
        );
        return Ok(());
    }
    let context: Context = serde_json::from_value(input["context"].clone())?;
    let public = input["proof"]["publicPackage"]
        .as_str()
        .ok_or("public group")?
        .to_string();
    if mode == "aggregate" {
        let pkg =
            frost::keys::PublicKeyPackage::deserialize(&bytes(&public)?).map_err(frost_error)?;
        let package = frost::SigningPackage::deserialize(&bytes(
            input["proof"]["package"].as_str().ok_or("package")?,
        )?)
        .map_err(frost_error)?;
        let mut shares = BTreeMap::new();
        for share in input["proof"]["shares"].as_array().ok_or("shares")? {
            let id: frost::Identifier =
                u16::try_from(share["participant"].as_u64().ok_or("participant")?)?
                    .try_into()
                    .map_err(frost_error)?;
            shares.insert(
                id,
                frost::round2::SignatureShare::deserialize(&bytes(
                    share["share"].as_str().ok_or("share")?,
                )?)
                .map_err(frost_error)?,
            );
        }
        let signature = frost::aggregate(&package, &shares, &pkg).map_err(frost_error)?;
        input["proof"]["signature"] =
            Value::String(hex(&signature.serialize().map_err(frost_error)?));
    }
    let checked = proof::verify(&context, &public, &input["proof"])?;
    println!(
        "{}",
        if mode == "aggregate" {
            input["proof"].clone()
        } else {
            checked
        }
    );
    Ok(())
}
fn main() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    if ["setup", "package", "aggregate", "verify", "public"]
        .contains(&args.get(1).map(String::as_str).unwrap_or(""))
    {
        return helper(&args[1], &args);
    }
    let config: Config = serde_json::from_slice(&fs::read(args.get(1).ok_or("config required")?)?)?;
    if args.get(2).map(String::as_str) == Some("attack") {
        let delivery: Delivery =
            serde_json::from_slice(&fs::read(args.get(4).ok_or("delivery file required")?)?)?;
        let result = channel::send(
            &config,
            delivery.to,
            args.get(3).ok_or("address required")?,
            &delivery,
        );
        println!("{}", json!({"ok":result.is_ok()}));
        return Ok(());
    }
    aether_hotstuff_threshold_research::require(
        config.members.get(&config.participant)
            == Some(&aether_hotstuff_threshold_research::digest(&fs::read(
                &config.certificate,
            )?)),
        "local TLS identity is not the custody participant",
    )?;
    let store = Store::open(
        config.directory.clone(),
        config.context.clone(),
        config.participant,
        &config.master,
    )?;
    let address = channel::start(config.clone(), store.clone())?;
    println!(
        "{}",
        json!({"ready":address,"participant":config.participant,"pid":std::process::id()})
    );
    std::io::stdout().flush()?;
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        if line.len() > 128 * 1024 {
            return Err("control frame bound".into());
        }
        let action = || -> Result<Value> {
            match serde_json::from_str::<Command>(&line)? {
                Command::Start => store.start(),
                Command::Send { phase, targets } => {
                    let mut receipts = Vec::new();
                    for (to, address) in targets {
                        let to = to.parse()?;
                        let delivery = store.outgoing(&phase, to)?;
                        receipts.push(channel::send(&config, to, &address, &delivery)?);
                    }
                    Ok(json!({"receipts":receipts}))
                }
                Command::Raw {
                    to,
                    address,
                    delivery,
                } => channel::send(&config, to, &address, &delivery),
                Command::Part2 => store.part2(),
                Command::Part3 => store.part3(),
                Command::Reserve {
                    nonce,
                    message,
                    authorization,
                } => store.reserve(&nonce, &message, &authorization),
                Command::Sign { nonce, package } => store.sign(&nonce, &package),
                Command::Status => store.status(),
                Command::Verify { proof } => store.verify(&proof),
                Command::Retire { decision } => store.retire(&decision),
            }
        };
        let reply = match action() {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        };
        println!("{reply}");
        std::io::stdout().flush()?;
    }
    Ok(())
}
