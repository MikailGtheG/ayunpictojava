//! Local three-device MLS demonstration, deliberately no server and no stored keys.
//! Run: cargo run --example three_devices
use pictochat_mls_lab::client::{Client, Incoming, KIND_APPLICATION, KIND_COMMIT};

fn main() {
    let mut alice = Client::new(b"Alice");
    let mut bob = Client::new(b"Bob");
    let mut charlie = Client::new(b"Charlie");

    alice.start_group();
    let (_commit, welcome) = alice.add(&bob.key_package());
    bob.accept_welcome(&welcome, alice.ratchet_tree());

    let (add_charlie, welcome) = alice.add(&charlie.key_package());
    assert_eq!(bob.process(&add_charlie, KIND_COMMIT).unwrap(), Incoming::MembershipChanged);
    charlie.accept_welcome(&welcome, alice.ratchet_tree());

    println!("MLS group joined: {} members, epoch {}", alice.count(), alice.epoch());
    let ciphertext = alice.send("Hallo Charlie 👋 – Zeichnung ✏️".as_bytes());
    match charlie.process(&ciphertext, KIND_APPLICATION).unwrap() {
        Incoming::Application(body) => println!("Charlie decrypted: {}", String::from_utf8(body).unwrap()),
        _ => panic!("Unexpected MLS content"),
    }

    let epoch_before = alice.epoch();
    let removal = alice.remove(bob.own_leaf());
    assert_eq!(bob.process(&removal, KIND_COMMIT).unwrap(), Incoming::Removed);
    assert_eq!(charlie.process(&removal, KIND_COMMIT).unwrap(), Incoming::MembershipChanged);
    println!("Bob removed. Epoch {} -> {}, members {}", epoch_before, alice.epoch(), alice.count());

    let ciphertext = charlie.send("Nach dem Ausschluss: vertraulich für Alice".as_bytes());
    assert!(bob.process(&ciphertext, KIND_APPLICATION).is_err());
    match alice.process(&ciphertext, KIND_APPLICATION).unwrap() {
        Incoming::Application(body) => println!("Alice decrypted: {}", String::from_utf8(body).unwrap()),
        _ => panic!("Unexpected MLS content"),
    }
    println!("MLS demonstration passed: removed member cannot decrypt new-epoch messages.");
}
