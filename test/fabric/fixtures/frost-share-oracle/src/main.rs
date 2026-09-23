//! Test-only public transcript oracle; no secret/signing operations.
use frost_ed25519 as frost;
use serde_json::{json, Value};
use std::{collections::BTreeMap, io::Read};
fn bytes(value: &Value) -> Result<Vec<u8>, ()> {
    let value = value.as_str().ok_or(())?;
    if value.len() > 256 * 1024 || value.len() % 2 != 0 {
        return Err(());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).map_err(|_| ()))
        .collect()
}
fn check(value: &Value) -> Result<Value, ()> {
    let public = frost::keys::PublicKeyPackage::deserialize(&bytes(&value["publicPackage"])?)
        .map_err(|_| ())?;
    let package =
        frost::SigningPackage::deserialize(&bytes(&value["signingPackage"])?).map_err(|_| ())?;
    let mut shares = BTreeMap::new();
    let mut individual = Vec::new();
    for (identifier, encoded) in value["shares"].as_object().ok_or(())? {
        let id: frost::Identifier = identifier
            .parse::<u16>()
            .map_err(|_| ())?
            .try_into()
            .map_err(|_| ())?;
        let share = frost::round2::SignatureShare::deserialize(&bytes(encoded)?).map_err(|_| ())?;
        let verifying_share = public.verifying_shares().get(&id).ok_or(())?;
        individual.push(
            frost_core::verify_signature_share(
                id,
                verifying_share,
                &share,
                &package,
                public.verifying_key(),
            )
            .is_ok(),
        );
        shares.insert(id, share);
    }
    Ok(
        json!({"deserialized":true,"sharesValid":individual,"aggregateValid":frost::aggregate(&package,&shares,&public).is_ok()}),
    )
}
fn main() {
    let mut text = String::new();
    std::io::stdin()
        .take(16 * 1024 * 1024)
        .read_to_string(&mut text)
        .unwrap();
    let input: Vec<Value> = serde_json::from_str(&text).unwrap();
    let output: Vec<Value> = input
        .iter()
        .map(|value| {
            check(value)
                .unwrap_or(json!({"deserialized":false,"sharesValid":[],"aggregateValid":false}))
        })
        .collect();
    println!("{}", serde_json::to_string(&output).unwrap());
}
