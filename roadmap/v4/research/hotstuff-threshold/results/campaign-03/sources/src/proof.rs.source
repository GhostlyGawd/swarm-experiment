//! Research authorization and public threshold proof checks. No signing here.
use crate::{bytes, custody::Context, frost_error, hex, require, Result};
use base64::Engine;
use frost_ristretto255 as frost;
use serde_json::{json, Value};
use std::collections::BTreeMap;
pub fn subject(context: &Context, public: &str, message: &str) -> Result<Value> {
    let raw = bytes(message)?;
    require(raw.len() <= 32 * 1024, "threshold subject limit")?;
    let value: Value = serde_json::from_slice(&raw)?;
    require(
        serde_json::to_vec(&value)? == raw
            && value["format"] == "aether.hotstuff-custody-subject/1"
            && value["context"] == serde_json::to_value(context)?,
        "threshold context/message mismatch",
    )?;
    let public =
        frost::keys::PublicKeyPackage::deserialize(&bytes(public)?).map_err(frost_error)?;
    require(
        value["group_public_key"]
            == hex(&public.verifying_key().serialize().map_err(frost_error)?),
        "wrong threshold group",
    )?;
    let vote = &value["vote"];
    let keys = [
        "format",
        "roster",
        "repositoryId",
        "membershipEpoch",
        "policyEpoch",
        "view",
        "phase",
        "parentBlock",
        "proposal",
        "expectedParent",
        "candidateManifest",
        "block",
    ];
    require(
        vote.as_object()
            .map(|map| map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key)))
            .unwrap_or(false),
        "vote subject schema",
    )?;
    require(
        vote["format"] == "aether.quorum-vote/1"
            && vote["roster"] == context.vote_roster
            && vote["repositoryId"] == context.repository
            && vote["membershipEpoch"] == context.membership_epoch
            && vote["policyEpoch"] == context.policy_epoch,
        "stale vote roster/epoch/policy",
    )?;
    let view = vote["view"].as_str().ok_or("vote view")?;
    let number: u64 = view.parse()?;
    require(
        number > 0 && number <= 4096 && number.to_string() == view,
        "vote view bound",
    )?;
    require(
        ["prepare", "precommit", "commit"].contains(&vote["phase"].as_str().ok_or("vote phase")?),
        "vote phase",
    )?;
    Ok(vote.clone())
}
pub fn authorize(
    context: &Context,
    participant: u16,
    vote: &Value,
    authorization: &Value,
) -> Result<()> {
    require((1..=4).contains(&participant), "unknown voter")?;
    let index = usize::from(participant - 1);
    require(
        authorization
            .as_object()
            .map(|map| {
                map.len() == 3
                    && map.contains_key("body")
                    && map.contains_key("signer")
                    && map.contains_key("signature")
            })
            .unwrap_or(false),
        "vote authorization schema",
    )?;
    require(
        authorization["body"] == *vote && authorization["signer"] == context.vote_ids[index],
        "foreign vote authorization",
    )?;
    let encoded = authorization["signature"]
        .as_str()
        .ok_or("vote signature")?;
    let signature = base64::engine::general_purpose::STANDARD.decode(encoded)?;
    require(
        signature.len() == 64
            && base64::engine::general_purpose::STANDARD.encode(&signature) == encoded,
        "noncanonical vote signature",
    )?;
    let payload = serde_json::to_vec(
        &json!({"domain":"aether.quorum-vote-signature/1","body":vote,"signer":context.vote_ids[index]}),
    )?;
    ring::signature::UnparsedPublicKey::new(
        &ring::signature::ED25519,
        bytes(&context.vote_public_keys[index])?,
    )
    .verify(&payload, &signature)
    .map_err(|_| "invalid honest-validator vote authorization")?;
    Ok(())
}
pub fn verify(context: &Context, public: &str, proof: &Value) -> Result<Value> {
    require(
        proof["format"] == "aether.hotstuff-ristretto-proof/1" && proof["publicPackage"] == public,
        "threshold proof/group profile",
    )?;
    let message = proof["message"]
        .as_str()
        .ok_or("missing threshold message")?;
    let vote = subject(context, public, message)?;
    let public =
        frost::keys::PublicKeyPackage::deserialize(&bytes(public)?).map_err(frost_error)?;
    let package = frost::SigningPackage::deserialize(&bytes(
        proof["package"].as_str().ok_or("missing package")?,
    )?)
    .map_err(frost_error)?;
    require(
        package.message() == &bytes(message)? && public.min_signers() == Some(3),
        "threshold package subject mismatch",
    )?;
    let members = proof["shares"]
        .as_array()
        .ok_or("missing threshold shares")?;
    require(
        members.len() >= 3
            && members.len() <= 4
            && members.len() == package.signing_commitments().len(),
        "threshold share count",
    )?;
    let mut shares = BTreeMap::new();
    let mut previous = 0u16;
    for member in members {
        let participant =
            u16::try_from(member["participant"].as_u64().ok_or("participant index")?)?;
        require(
            participant > previous && participant <= 4,
            "duplicate threshold participant",
        )?;
        previous = participant;
        authorize(context, participant, &vote, &member["authorization"])?;
        let id = participant.try_into().map_err(frost_error)?;
        let share = frost::round2::SignatureShare::deserialize(&bytes(
            member["share"].as_str().ok_or("missing scalar share")?,
        )?)
        .map_err(frost_error)?;
        frost_core::verify_signature_share(
            id,
            public
                .verifying_shares()
                .get(&id)
                .ok_or("unknown verifying share")?,
            &share,
            &package,
            public.verifying_key(),
        )
        .map_err(frost_error)?;
        shares.insert(id, share);
    }
    let signature = frost::aggregate(&package, &shares, &public).map_err(frost_error)?;
    require(
        proof["signature"] == hex(&signature.serialize().map_err(frost_error)?),
        "group signature/aggregate mismatch",
    )?;
    public
        .verifying_key()
        .verify(package.message(), &signature)
        .map_err(frost_error)?;
    Ok(json!({"verified":true,"vote":vote,"participants":shares.len(),"productionAdmission":false}))
}
