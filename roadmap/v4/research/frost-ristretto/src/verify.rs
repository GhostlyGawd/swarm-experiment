//! Public-only verification using pinned FROST, in a fresh verifier process.
use crate::{bytes, hex, id, Result};
use frost_ristretto255 as frost;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub fn verify_transcript(value: &Value) -> Result<Value> {
    let object = value
        .as_object()
        .ok_or("public transcript object required")?;
    let keys = [
        "format",
        "session",
        "public_package",
        "group_public_key",
        "nonce_id",
        "signing_package",
        "signature_shares",
        "signature",
    ];
    if object.len() != keys.len()
        || keys.iter().any(|key| !object.contains_key(*key))
        || value["format"] != "aether.ristretto-public-transcript/1"
    {
        return Err("public transcript schema".into());
    }
    let text = |key: &str| {
        value[key]
            .as_str()
            .ok_or_else(|| format!("missing public {key}"))
    };
    if bytes(text("session")?)?.len() != 16 || text("nonce_id")?.len() > 64 {
        return Err("public session/nonce bound".into());
    }
    let public_bytes = bytes(text("public_package")?)?;
    let package_bytes = bytes(text("signing_package")?)?;
    let public =
        frost::keys::PublicKeyPackage::deserialize(&public_bytes).map_err(|e| format!("{e:?}"))?;
    let package =
        frost::SigningPackage::deserialize(&package_bytes).map_err(|e| format!("{e:?}"))?;
    if public.serialize().map_err(|e| format!("{e:?}"))? != public_bytes
        || package.serialize().map_err(|e| format!("{e:?}"))? != package_bytes
        || public.min_signers() != Some(3)
        || public.verifying_shares().len() != 4
        || (1..=4).any(|index| !public.verifying_shares().contains_key(&id(index).unwrap()))
    {
        return Err("public group/encoding mismatch".into());
    }
    if hex(&public
        .verifying_key()
        .serialize()
        .map_err(|e| format!("{e:?}"))?)
        != text("group_public_key")?
    {
        return Err("group key mismatch".into());
    }
    let subject: Value =
        serde_json::from_slice(package.message()).map_err(|_| "invalid subject JSON")?;
    if serde_json::to_vec(&subject).map_err(|e| e.to_string())? != *package.message()
        || subject["domain"] != "aether.quorum-ristretto-vote-prototype/1"
        || subject["ciphersuite"] != "FROST-RISTRETTO255-SHA512-v1"
        || subject["dkgSession"] != value["session"]
        || subject["threshold"] != 3
        || subject["groupSigner"] != format!("frost-ristretto255:{}", text("group_public_key")?)
    {
        return Err("Ristretto subject domain/group binding mismatch".into());
    }
    let selected = subject["participants"]
        .as_array()
        .ok_or("missing participant list")?;
    let raw_shares = value["signature_shares"]
        .as_object()
        .ok_or("missing share map")?;
    if selected.len() < 3
        || selected.len() > 4
        || selected.len() != raw_shares.len()
        || selected.len() != package.signing_commitments().len()
    {
        return Err("threshold participant count mismatch".into());
    }
    let mut previous = 0u16;
    let mut shares = BTreeMap::new();
    let mut share_checks = Vec::new();
    for participant in selected {
        let index = u16::try_from(
            participant["participant"]
                .as_u64()
                .ok_or("invalid participant index")?,
        )
        .map_err(|_| "invalid participant")?;
        if index <= previous {
            return Err("duplicate/out-of-order participant".into());
        }
        previous = index;
        let identifier = id(index)?;
        let raw = raw_shares
            .get(&index.to_string())
            .and_then(Value::as_str)
            .ok_or("missing signature share")?;
        let share = frost::round2::SignatureShare::deserialize(&bytes(raw)?)
            .map_err(|e| format!("{e:?}"))?;
        frost_core::verify_signature_share(
            identifier,
            public
                .verifying_shares()
                .get(&identifier)
                .ok_or("unknown verifying share")?,
            &share,
            &package,
            public.verifying_key(),
        )
        .map_err(|e| format!("{e:?}"))?;
        share_checks.push(index);
        shares.insert(identifier, share);
    }
    let signature =
        frost::Signature::deserialize(&bytes(text("signature")?)?).map_err(|e| format!("{e:?}"))?;
    public
        .verifying_key()
        .verify(package.message(), &signature)
        .map_err(|e| format!("{e:?}"))?;
    let aggregate = frost::aggregate(&package, &shares, &public).map_err(|e| format!("{e:?}"))?;
    if aggregate.serialize().map_err(|e| format!("{e:?}"))?
        != signature.serialize().map_err(|e| format!("{e:?}"))?
    {
        return Err("signature/transcript aggregation mismatch".into());
    }
    Ok(
        json!({"valid":true,"participants":share_checks,"group_public_key":value["group_public_key"],"message_hex":hex(package.message()),"subject":subject}),
    )
}
