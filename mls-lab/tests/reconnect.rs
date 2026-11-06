use pictochat_mls_lab::client::{Client, KIND_APPLICATION};

#[test]
fn reconnect_fails_closed_until_cryptographic_rejoin() {
    let mut alice = Client::new(b"Alice").unwrap();
    let mut bob = Client::new(b"Bob").unwrap();
    alice.start_group().unwrap();
    let (_, welcome) = alice.add(&bob.key_package().unwrap()).unwrap();
    bob.accept_welcome(&welcome, alice.ratchet_tree().unwrap()).unwrap();
    assert!(alice.synchronized());
    assert!(bob.synchronized());

    let before = alice.send(b"before disconnect").unwrap();
    assert!(bob.process(&before, KIND_APPLICATION).is_ok());
    bob.mark_transport_interrupted();
    assert!(!bob.synchronized());
    assert!(bob.send(b"not permitted after disconnect").is_err());
    assert!(bob.process(&before, KIND_APPLICATION).is_err());
    assert!(bob.add(&alice.key_package().unwrap()).is_err());

    // A network reconnect alone is NOT proof that no MLS commits were missed.
    // An explicit fresh, verified membership/Welcome flow is required.
    bob.abandon_group_for_rejoin();
    assert!(!bob.synchronized());
    assert!(bob.send(b"still blocked").is_err());
    assert!(bob.count().is_err());
    assert!(bob.epoch().is_err());
    assert!(bob.own_leaf().is_err());
}

#[test]
fn interrupted_group_cannot_issue_removal_or_message() {
    let mut alice = Client::new(b"Alice").unwrap();
    let mut bob = Client::new(b"Bob").unwrap();
    alice.start_group().unwrap();
    let (_, welcome) = alice.add(&bob.key_package().unwrap()).unwrap();
    bob.accept_welcome(&welcome, alice.ratchet_tree().unwrap()).unwrap();
    alice.mark_transport_interrupted();
    assert!(!alice.synchronized());
    assert!(alice.remove(bob.own_leaf().unwrap()).is_err());
    assert!(alice.send(b"stale epoch").is_err());
}
