use pictochat_mls_lab::client::{Client, Incoming, KIND_APPLICATION, KIND_COMMIT};

#[test]
fn endpoint_owned_group_client_handles_three_peers_and_removal() {
    let mut alice = Client::new(b"Alice");
    let mut bob = Client::new(b"Bob");
    let mut charlie = Client::new(b"Charlie");

    alice.start_group();
    let (bob_add, welcome_bob) = alice.add(&bob.key_package());
    bob.accept_welcome(&welcome_bob, alice.ratchet_tree());
    assert_eq!(alice.count(), 2);
    assert_eq!(bob.count(), 2);
    let initial_message = alice.send("Hallo ÄÖÜ ğışç 😊".as_bytes());
    assert_eq!(
        bob.process(&initial_message, KIND_APPLICATION).unwrap(),
        Incoming::Application("Hallo ÄÖÜ ğışç 😊".as_bytes().to_vec())
    );

    let (charlie_add, welcome_charlie) = alice.add(&charlie.key_package());
    assert_eq!(bob.process(&charlie_add, KIND_COMMIT).unwrap(), Incoming::MembershipChanged);
    charlie.accept_welcome(&welcome_charlie, alice.ratchet_tree());
    assert_eq!(alice.count(), 3);
    assert_eq!(bob.count(), 3);
    assert_eq!(charlie.count(), 3);
    assert_eq!(alice.epoch(), bob.epoch());
    assert_eq!(alice.epoch(), charlie.epoch());

    let before = alice.epoch();
    let remove = alice.remove(bob.own_leaf());
    assert_eq!(charlie.process(&remove, KIND_COMMIT).unwrap(), Incoming::MembershipChanged);
    assert_eq!(bob.process(&remove, KIND_COMMIT).unwrap(), Incoming::Removed);
    assert!(!bob.active());
    assert!(charlie.active());
    assert_eq!(alice.count(), 2);
    assert_eq!(charlie.count(), 2);
    assert!(alice.epoch() > before);
    assert_eq!(alice.epoch(), charlie.epoch());

    let encrypted = alice.send("Neue Epoche: Alice und Charlie".as_bytes());
    assert_eq!(
        charlie.process(&encrypted, KIND_APPLICATION).unwrap(),
        Incoming::Application("Neue Epoche: Alice und Charlie".as_bytes().to_vec())
    );
    assert!(bob.process(&encrypted, KIND_APPLICATION).is_err());
    assert!(bob.process(&initial_message, KIND_APPLICATION).is_err());
    assert!(bob.process(&remove, KIND_APPLICATION).is_err());
    // A duplicated Commit cannot be merged again in a later epoch.
    assert!(charlie.process(&remove, KIND_COMMIT).is_err());
    // Older v2 browser framing must not accidentally be treated as MLS.
    assert!(charlie.process(&[2, 1, 42], KIND_APPLICATION).is_err());
    let _ = bob_add;
}

#[test]
fn malformed_control_packets_rejected_before_mls_processing() {
    use pictochat_mls_lab::client::{wrap, unwrap, KIND_WELCOME, KIND_KEY_PACKAGE, MAX_WIRE_SIZE};
    assert!(wrap(0, vec![1]).is_err());
    assert!(wrap(KIND_APPLICATION, vec![]).is_err());
    assert!(wrap(KIND_COMMIT, vec![9; MAX_WIRE_SIZE]).is_err());
    assert!(unwrap(&[3, KIND_APPLICATION], KIND_APPLICATION).is_err());
    assert!(unwrap(&[3, KIND_WELCOME, 9], KIND_APPLICATION).is_err());
    assert!(unwrap(&[3, KIND_KEY_PACKAGE, 9], KIND_COMMIT).is_err());
    assert!(unwrap(&[2, KIND_APPLICATION, 9], KIND_APPLICATION).is_err());
}
