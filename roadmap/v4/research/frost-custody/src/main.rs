use aether_frost_custody_research::{
    channel::{self, Config},
    custody::{Delivery, Store},
    Result,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, Write},
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
    },
    Sign {
        nonce: String,
        package: String,
    },
    Status,
}
fn main() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
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
    aether_frost_custody_research::require(
        config.members.get(&config.participant)
            == Some(&aether_frost_custody_research::digest(&fs::read(
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
                Command::Reserve { nonce, message } => store.reserve(&nonce, &message),
                Command::Sign { nonce, package } => store.sign(&nonce, &package),
                Command::Status => store.status(),
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
