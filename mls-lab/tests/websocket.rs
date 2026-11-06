//! A live websocket test for *real OpenMLS-produced* Welcome, application and
//! Commit messages. Requires the loopback-only Rust server on port 8787.
//! Ignored for normal cargo test; CI starts the server and runs it explicitly.
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use openmls::prelude::{tls_codec::*, *};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use sha2::Sha256;
use tokio_tungstenite::{connect_async, tungstenite::{client::IntoClientRequest, Message}};

const ROOM: &str = "0123456789abcdef0123456789abcdef";

fn identity(id: &[u8], suite: Ciphersuite, provider: &OpenMlsRustCrypto) -> (CredentialWithKey, SignatureKeyPair) {
    let signer = SignatureKeyPair::new(suite.signature_algorithm()).unwrap();
    signer.store(provider.storage()).unwrap();
    (CredentialWithKey {
        credential: BasicCredential::new(id.to_vec()).into(),
        signature_key: signer.public().into(),
    }, signer)
}
fn frame(kind: u8, payload: Vec<u8>) -> Vec<u8> {
    let mut out = vec![3, kind];
    out.extend(payload);
    out
}
fn decode_frame(bytes: &[u8], kind: u8) -> MlsMessageIn {
    assert_eq!(bytes[0], 3);
    assert_eq!(bytes[1], kind);
    MlsMessageIn::tls_deserialize(&mut &bytes[2..]).unwrap()
}
fn capability() -> String {
    let secret = std::env::var("PICTOCHAT_RELAY_SECRET").expect("CI secret must be set");
    let raw = hex::decode(secret).unwrap();
    let mut mac = Hmac::<Sha256>::new_from_slice(&raw).unwrap();
    mac.update(b"pictochat-room-capability-v1:");
    mac.update(ROOM.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

#[tokio::test]
#[ignore = "requires local Rust relay on 127.0.0.1:8787 and test secret"]
async fn openmls_messages_cross_real_websocket_and_member_is_revoked() {
    let url = format!("ws://127.0.0.1:8787/ws/{ROOM}");
    let mut request = url.as_str().into_client_request().unwrap();
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        format!("picto.v1, auth.{}", capability()).parse().unwrap(),
    );
    let (mut alice_socket, _) = connect_async(request.clone()).await.unwrap();
    let (mut bob_socket, _) = connect_async(request).await.unwrap();
    let suite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
    let ap = OpenMlsRustCrypto::default();
    let bp = OpenMlsRustCrypto::default();
    let (ac, asigner) = identity(b"Alice", suite, &ap);
    let (bc, bsigner) = identity(b"Bob", suite, &bp);
    let bk = KeyPackage::builder().build(suite, &bp, &bsigner, bc).unwrap();
    let mut alice = MlsGroup::new(&ap, &asigner, &MlsGroupCreateConfig::default(), ac).unwrap();

    let (_, welcome, _) = alice.add_members(&ap, &asigner, &[bk.key_package().clone()]).unwrap();
    alice.merge_pending_commit(&ap).unwrap();
    let sent = frame(3, welcome.tls_serialize_detached().unwrap());
    alice_socket.send(Message::Binary(sent.clone().into())).await.unwrap();
    let bytes = tokio::time::timeout(std::time::Duration::from_secs(4), bob_socket.next()).await.unwrap().unwrap().unwrap().into_data();
    assert_eq!(bytes.as_ref(), sent.as_slice());
    let welcome = match decode_frame(&bytes, 3).extract() {
        MlsMessageBodyIn::Welcome(w) => w,
        _ => panic!("Expected MLS welcome"),
    };
    let mut bob = StagedWelcome::new_from_welcome(
        &bp, &MlsGroupJoinConfig::default(), welcome,
        Some(alice.export_ratchet_tree().into()),
    ).unwrap().into_group(&bp).unwrap();

    let plain = "MLS over WS: ÄÖÜ ß ğışç 😊".as_bytes();
    let encrypted = alice.create_message(&ap, &asigner, plain).unwrap();
    let sent = frame(1, encrypted.tls_serialize_detached().unwrap());
    assert!(!sent.windows(plain.len()).any(|w| w == plain));
    alice_socket.send(Message::Binary(sent.clone().into())).await.unwrap();
    let bytes = tokio::time::timeout(std::time::Duration::from_secs(4), bob_socket.next()).await.unwrap().unwrap().unwrap().into_data();
    assert_eq!(bytes.as_ref(), sent.as_slice());
    let processed = bob.process_message(&bp, decode_frame(&bytes, 1).try_into_protocol_message().unwrap()).unwrap();
    match processed.into_content() {
        ProcessedMessageContent::ApplicationMessage(m) => assert_eq!(m.into_bytes(), plain),
        _ => panic!("Expected MLS application message"),
    }

    let previous = alice.epoch();
    let (commit, _, _) = alice.remove_members(&ap, &asigner, &[bob.own_leaf_index()]).unwrap();
    alice.merge_pending_commit(&ap).unwrap();
    alice_socket.send(Message::Binary(frame(2, commit.tls_serialize_detached().unwrap()).into())).await.unwrap();
    let bytes = tokio::time::timeout(std::time::Duration::from_secs(4), bob_socket.next()).await.unwrap().unwrap().unwrap().into_data();
    let processed = bob.process_message(&bp, decode_frame(&bytes, 2).try_into_protocol_message().unwrap()).unwrap();
    match processed.into_content() {
        ProcessedMessageContent::StagedCommitMessage(staged) => bob.merge_staged_commit(&bp, *staged).unwrap(),
        _ => panic!("Expected MLS remove commit"),
    }
    assert_ne!(alice.epoch(), previous);
    assert!(!bob.is_active());
    assert!(bob.create_message(&bp, &bsigner, b"revoked").is_err());
    alice_socket.close(None).await.unwrap();
    bob_socket.close(None).await.unwrap();
}
