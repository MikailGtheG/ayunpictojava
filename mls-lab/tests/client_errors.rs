use pictochat_mls_lab::client::{Client, KIND_APPLICATION, KIND_COMMIT, KIND_WELCOME, wrap, unwrap, MAX_WIRE_SIZE, MAX_APPLICATION_PLAINTEXT_BYTES};

#[test]
fn invalid_states_return_errors_without_panicking() {
    assert!(Client::new(b"").is_err());
    assert!(Client::new(&[b'x'; 65]).is_err());
    let mut alice = Client::new(b"Alice").unwrap();
    let bob = Client::new(b"Bob").unwrap();
    assert!(alice.send(b"before join").is_err());
    assert!(alice.own_leaf().is_err());
    assert!(alice.epoch().is_err());
    assert!(alice.count().is_err());
    assert!(alice.ratchet_tree().is_err());
    assert!(alice.add(&bob.key_package().unwrap()).is_err());
    assert!(alice.process(&[3, KIND_APPLICATION, 0], KIND_APPLICATION).is_err());
    alice.start_group().unwrap();
    assert!(alice.start_group().is_err());
    assert!(alice.send(b"").is_err());
    assert!(alice.send(&vec![b'a'; MAX_WIRE_SIZE]).is_err());
    assert!(alice.send(&vec![b'a'; MAX_APPLICATION_PLAINTEXT_BYTES + 1]).is_err());
    assert!(alice.send(b"valid after invalid request").is_ok());
    assert!(alice.accept_welcome(&[3, KIND_WELCOME, 0], alice.ratchet_tree().unwrap()).is_err());
}
#[test]
fn framing_rejects_ambiguous_or_malformed_data() {
    assert!(wrap(KIND_APPLICATION, vec![]).is_err());
    assert!(wrap(0, vec![1]).is_err());
    assert!(unwrap(&[3, KIND_APPLICATION], KIND_APPLICATION).is_err());
    assert!(unwrap(&[3, KIND_APPLICATION, 1, 2, 3], KIND_APPLICATION).is_err());
    assert!(unwrap(&[2, KIND_COMMIT, 1, 2, 3], KIND_COMMIT).is_err());
}
