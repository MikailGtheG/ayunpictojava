//! MLS-generated application and control messages travel through the SAME
//! in-memory Rust relay implementation used by the WebSocket server.
//! No MLS secrets or plaintext are handed to the relay.
use openmls::prelude::{tls_codec::*, *};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use pictochat_relay::{Rooms, MLS_KIND_APPLICATION, MLS_KIND_COMMIT, MLS_KIND_WELCOME, MLS_FRAME_VERSION};

const ROOM: &str = "0123456789abcdef0123456789abcdef";
fn identity(id: &[u8], suite: Ciphersuite, provider: &OpenMlsRustCrypto) -> (CredentialWithKey, SignatureKeyPair) {
    let signer = SignatureKeyPair::new(suite.signature_algorithm()).unwrap();
    signer.store(provider.storage()).unwrap();
    (CredentialWithKey {
        credential: BasicCredential::new(id.to_vec()).into(),
        signature_key: signer.public().into(),
    }, signer)
}
fn frame(kind: u8, mls: Vec<u8>) -> Vec<u8> {
    let mut result = vec![MLS_FRAME_VERSION, kind];
    result.extend(mls);
    result
}
fn parsed_frame(frame: &[u8], kind: u8) -> MlsMessageIn {
    assert_eq!(frame[0], MLS_FRAME_VERSION);
    assert_eq!(frame[1], kind);
    MlsMessageIn::tls_deserialize(&mut &frame[2..]).unwrap()
}
#[test]
fn relay_transports_real_mls_welcome_application_and_removal_commit() {
    let suite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
    let ap = OpenMlsRustCrypto::default();
    let bp = OpenMlsRustCrypto::default();
    let (ac, asigner) = identity(b"Alice", suite, &ap);
    let (bc, bsigner) = identity(b"Bob", suite, &bp);
    let bk = KeyPackage::builder().build(suite, &bp, &bsigner, bc).unwrap();
    let rooms = Rooms::default();
    let shared = rooms.join(ROOM).unwrap();
    let mut receiver = shared.subscribe();

    let mut alice = MlsGroup::new(&ap, &asigner, &MlsGroupCreateConfig::default(), ac).unwrap();
    let (_, welcome, _) = alice.add_members(&ap, &asigner, &[bk.key_package().clone()]).unwrap();
    alice.merge_pending_commit(&ap).unwrap();
    let welcome_wire = frame(MLS_KIND_WELCOME, welcome.tls_serialize_detached().unwrap());
    shared.publish(welcome_wire.clone()).unwrap();
    let welcome_recv = receiver.try_recv().unwrap();
    assert_eq!(welcome_recv, welcome_wire);
    let welcome = match parsed_frame(&welcome_recv, MLS_KIND_WELCOME).extract() {
        MlsMessageBodyIn::Welcome(w) => w,
        _ => panic!("Expected Welcome"),
    };
    let mut bob = StagedWelcome::new_from_welcome(
        &bp, &MlsGroupJoinConfig::default(), welcome,
        Some(alice.export_ratchet_tree().into()),
    ).unwrap().into_group(&bp).unwrap();

    let message = "Group: ÄÖÜ ğışç 😊 – strokes:[[1,2]]".as_bytes();
    let mls = alice.create_message(&ap, &asigner, message).unwrap();
    let sent = frame(MLS_KIND_APPLICATION, mls.tls_serialize_detached().unwrap());
    assert!(!sent.windows(message.len()).any(|window| window == message));
    shared.publish(sent.clone()).unwrap();
    let received = receiver.try_recv().unwrap();
    assert_eq!(received, sent);
    let processed = bob.process_message(&bp, parsed_frame(&received, MLS_KIND_APPLICATION).try_into_protocol_message().unwrap()).unwrap();
    match processed.into_content() {
        ProcessedMessageContent::ApplicationMessage(app) => assert_eq!(app.into_bytes(), message),
        _ => panic!("Expected MLS application message"),
    }

    let previous_epoch = alice.epoch();
    let (commit, _, _) = alice.remove_members(&ap, &asigner, &[bob.own_leaf_index()]).unwrap();
    alice.merge_pending_commit(&ap).unwrap();
    shared.publish(frame(MLS_KIND_COMMIT, commit.tls_serialize_detached().unwrap())).unwrap();
    let received = receiver.try_recv().unwrap();
    let processed = bob.process_message(&bp, parsed_frame(&received, MLS_KIND_COMMIT).try_into_protocol_message().unwrap()).unwrap();
    match processed.into_content() {
        ProcessedMessageContent::StagedCommitMessage(staged) => bob.merge_staged_commit(&bp, *staged).unwrap(),
        _ => panic!("Expected removal commit"),
    }
    assert_ne!(previous_epoch, alice.epoch());
    assert!(!bob.is_active());
    assert!(bob.create_message(&bp, &bsigner, b"revoked").is_err());
}
