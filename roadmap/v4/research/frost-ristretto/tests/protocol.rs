use aether_frost_ristretto_prototype::{bytes, hex, id, Participant, Request};
use frost_ristretto255 as frost;
use serde_json::Value;
use std::collections::BTreeMap;

#[test]
fn actual_json_wire_decodes_canonical_participant_keys_and_refuses_duplicates() {
    let good = r#"{"op":"Part2","session":"11111111111111111111111111111111","packages":{"2":"ff","3":"ff","4":"ff"}}"#;
    assert!(serde_json::from_str::<Request>(good).is_ok());
    assert!(serde_json::from_str::<Request>(
        &good.replace("\"2\":\"ff\"", "\"2\":\"ff\",\"2\":\"00\"")
    )
    .is_err());
    assert!(serde_json::from_str::<Request>(&good.replace("\"2\":", "\"02\":")).is_err());
}

struct Prepared {
    members: Vec<Participant>,
    session: String,
    outbound: Vec<BTreeMap<u16, String>>,
}
fn prepared(session: &str) -> Prepared {
    let mut members = (1..=4)
        .map(|id| Participant::new(id).unwrap())
        .collect::<Vec<_>>();
    let r1 = members
        .iter_mut()
        .map(|member| {
            member
                .handle(Request::Begin {
                    session: session.into(),
                })
                .unwrap()["package"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect::<Vec<_>>();
    let mut outbound = Vec::new();
    for (index, member) in members.iter_mut().enumerate() {
        let packages = (1..=4u16)
            .filter(|id| usize::from(*id - 1) != index)
            .map(|id| (id, r1[usize::from(id - 1)].clone()))
            .collect();
        let reply = member
            .handle(Request::Part2 {
                session: session.into(),
                packages,
            })
            .unwrap();
        outbound.push(serde_json::from_value(reply["packages"].clone()).unwrap());
    }
    Prepared {
        members,
        session: session.into(),
        outbound,
    }
}
fn incoming(group: &Prepared, receiver: u16) -> BTreeMap<u16, String> {
    (1..=4u16)
        .filter(|id| *id != receiver)
        .map(|id| (id, group.outbound[usize::from(id - 1)][&receiver].clone()))
        .collect()
}
fn finish(group: &mut Prepared) -> Vec<Value> {
    let mut public = Vec::new();
    for index in 0..4 {
        let packages = incoming(group, (index + 1) as u16);
        public.push(
            group.members[index]
                .handle(Request::Part3 {
                    session: group.session.clone(),
                    packages,
                })
                .unwrap(),
        );
    }
    public
}

#[test]
fn all_four_participants_derive_identical_public_package_without_a_dealer() {
    let mut group = prepared("11111111111111111111111111111111");
    let public = finish(&mut group);
    assert!(public
        .iter()
        .all(|value| value["public_package"] == public[0]["public_package"]));
    assert_eq!(
        bytes(public[0]["group_key"].as_str().unwrap())
            .unwrap()
            .len(),
        32
    );
}
#[test]
fn stale_dkg_private_packages_do_not_validate_against_a_new_session_commitment_set() {
    let old = prepared("11111111111111111111111111111111");
    let mut fresh = prepared("22222222222222222222222222222222");
    let outcome = fresh.members[0].handle(Request::Part3 {
        session: fresh.session.clone(),
        packages: incoming(&old, 1),
    });
    assert!(outcome.is_err());
    let fresh_packages = incoming(&fresh, 1);
    assert!(
        fresh.members[0]
            .handle(Request::Part3 {
                session: fresh.session.clone(),
                packages: fresh_packages
            })
            .is_err(),
        "failed cryptographic DKG attempt is consumed"
    );
}
#[test]
fn malformed_or_incomplete_round_one_packages_never_complete_key_generation() {
    let mut member = Participant::new(1).unwrap();
    let session = "11111111111111111111111111111111".to_string();
    member
        .handle(Request::Begin {
            session: session.clone(),
        })
        .unwrap();
    assert!(member
        .handle(Request::Part2 {
            session: session.clone(),
            packages: BTreeMap::from([(2, "ff".into()), (3, "ff".into()), (4, "ff".into())])
        })
        .is_err());
    assert!(member
        .handle(Request::Part2 {
            session: session.clone(),
            packages: BTreeMap::new()
        })
        .is_err());
    assert!(member
        .handle(Request::Commit {
            session,
            nonce: "no-key".into(),
            message: "01".into()
        })
        .is_err());
}
#[test]
fn signer_rejects_changed_message_commitment_and_burns_the_nonce_before_failure() {
    let mut group = prepared("11111111111111111111111111111111");
    finish(&mut group);
    let mut commitments = BTreeMap::new();
    for index in 0..3 {
        let reply = group.members[index]
            .handle(Request::Commit {
                session: group.session.clone(),
                nonce: "once".into(),
                message: "0102".into(),
            })
            .unwrap();
        commitments.insert(
            id((index + 1) as u16).unwrap(),
            frost::round1::SigningCommitments::deserialize(
                &bytes(reply["commitments"].as_str().unwrap()).unwrap(),
            )
            .unwrap(),
        );
    }
    let wrong = frost::SigningPackage::new(commitments.clone(), &[1, 3]);
    let good = frost::SigningPackage::new(commitments, &[1, 2]);
    assert!(group.members[0]
        .handle(Request::Sign {
            session: group.session.clone(),
            nonce: "once".into(),
            package: hex(&wrong.serialize().unwrap())
        })
        .is_err());
    assert!(group.members[0]
        .handle(Request::Sign {
            session: group.session.clone(),
            nonce: "once".into(),
            package: hex(&good.serialize().unwrap())
        })
        .is_err());
    assert!(group.members[0]
        .handle(Request::Commit {
            session: group.session.clone(),
            nonce: "once".into(),
            message: "0102".into()
        })
        .is_err());
}
#[test]
fn old_commitment_and_insufficient_selected_set_are_refused() {
    let mut group = prepared("11111111111111111111111111111111");
    finish(&mut group);
    let mut commitments = BTreeMap::new();
    for index in 0..3 {
        let reply = group.members[index]
            .handle(Request::Commit {
                session: group.session.clone(),
                nonce: "old".into(),
                message: "01".into(),
            })
            .unwrap();
        commitments.insert(
            id((index + 1) as u16).unwrap(),
            frost::round1::SigningCommitments::deserialize(
                &bytes(reply["commitments"].as_str().unwrap()).unwrap(),
            )
            .unwrap(),
        );
    }
    group.members[0]
        .handle(Request::Commit {
            session: group.session.clone(),
            nonce: "fresh".into(),
            message: "01".into(),
        })
        .unwrap();
    let old = frost::SigningPackage::new(commitments.clone(), &[1]);
    assert!(group.members[0]
        .handle(Request::Sign {
            session: group.session.clone(),
            nonce: "fresh".into(),
            package: hex(&old.serialize().unwrap())
        })
        .is_err());
    commitments.remove(&id(3).unwrap());
    let short = frost::SigningPackage::new(commitments, &[1]);
    assert!(group.members[1]
        .handle(Request::Sign {
            session: group.session.clone(),
            nonce: "old".into(),
            package: hex(&short.serialize().unwrap())
        })
        .is_err());
}
#[test]
fn restart_drops_session_authority_instead_of_restoring_spent_nonce_material() {
    let mut old = prepared("11111111111111111111111111111111");
    finish(&mut old);
    let mut restarted = Participant::new(1).unwrap();
    assert!(restarted
        .handle(Request::Commit {
            session: old.session,
            nonce: "from-old-process".into(),
            message: "01".into()
        })
        .is_err());
}

#[test]
fn participant_authentication_requires_its_own_share_and_every_peers_valid_share() {
    use ed25519_dalek::Verifier;
    use frost::Field;
    let mut group = prepared("11111111111111111111111111111111");
    let public = finish(&mut group);
    let public_package = frost::keys::PublicKeyPackage::deserialize(
        &bytes(public[0]["public_package"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    let subject = serde_json::json!({"domain":"aether.quorum-ristretto-vote-prototype/1","ciphersuite":"FROST-RISTRETTO255-SHA512-v1","dkgSession":group.session,"threshold":3,"groupSigner":format!("frost-ristretto255:{}",public[0]["group_key"].as_str().unwrap()),"participants":[{"participant":1},{"participant":2},{"participant":3}],"body":{"research":true}});
    let message = serde_json::to_vec(&subject).unwrap();
    let mut commitments = BTreeMap::new();
    for index in 0..3 {
        let value = group.members[index]
            .handle(Request::Commit {
                session: group.session.clone(),
                nonce: "attested".into(),
                message: hex(&message),
            })
            .unwrap();
        commitments.insert(
            id((index + 1) as u16).unwrap(),
            frost::round1::SigningCommitments::deserialize(
                &bytes(value["commitments"].as_str().unwrap()).unwrap(),
            )
            .unwrap(),
        );
    }
    let package = frost::SigningPackage::new(commitments, &message);
    let mut shares = BTreeMap::new();
    let mut share_hex = BTreeMap::new();
    for index in 0..3 {
        let value = group.members[index]
            .handle(Request::Sign {
                session: group.session.clone(),
                nonce: "attested".into(),
                package: hex(&package.serialize().unwrap()),
            })
            .unwrap();
        let raw = value["share"].as_str().unwrap();
        shares.insert(
            id((index + 1) as u16).unwrap(),
            frost::round2::SignatureShare::deserialize(&bytes(raw).unwrap()).unwrap(),
        );
        share_hex.insert(index + 1, raw.to_string());
    }
    let signature = frost::aggregate(&package, &shares, &public_package).unwrap();
    let transcript = serde_json::json!({"format":"aether.ristretto-public-transcript/1","session":group.session,"public_package":public[0]["public_package"],"group_public_key":public[0]["group_key"],"nonce_id":"attested","signing_package":hex(&package.serialize().unwrap()),"signature_shares":share_hex,"signature":hex(&signature.serialize().unwrap())});
    assert!(aether_frost_ristretto_prototype::verify::verify_transcript(&transcript).is_ok());
    let accepted = group.members[2]
        .handle(Request::Attest {
            session: group.session.clone(),
            nonce: "attested".into(),
            transcript: transcript.clone(),
        })
        .unwrap();
    let signed_bytes=serde_json::to_vec(&serde_json::json!({"domain":"aether.ristretto-participation/1","participant":3,"transcript":transcript})).unwrap();
    let identity = ed25519_dalek::SigningKey::from_bytes(&[3u8; 32]).verifying_key();
    identity
        .verify(
            &signed_bytes,
            &ed25519_dalek::Signature::from_slice(
                &bytes(accepted["authentication"].as_str().unwrap()).unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    let mut forged = transcript.clone();
    let mut one = [0u8; 32];
    one[0] = 1;
    let one = frost::RistrettoScalarField::deserialize(&one).unwrap();
    for (identifier, increase) in [("1", true), ("2", false)] {
        let raw: [u8; 32] = bytes(forged["signature_shares"][identifier].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let old = frost::RistrettoScalarField::deserialize(&raw).unwrap();
        let changed = if increase { old + one } else { old - one };
        forged["signature_shares"][identifier] =
            Value::String(hex(&frost::RistrettoScalarField::serialize(&changed)));
    }
    // The group signature is unchanged and remains valid, but the two altered
    // peer shares must not be endorsed by the third honest participant.
    public_package
        .verifying_key()
        .verify(&message, &signature)
        .unwrap();
    assert!(group.members[2]
        .handle(Request::Attest {
            session: group.session.clone(),
            nonce: "attested".into(),
            transcript: forged
        })
        .is_err());
    assert!(
        group.members[3]
            .handle(Request::Attest {
                session: group.session.clone(),
                nonce: "attested".into(),
                transcript
            })
            .is_err(),
        "nonparticipant cannot attest an unproduced share"
    );
}
