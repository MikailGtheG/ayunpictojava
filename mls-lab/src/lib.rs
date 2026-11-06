//! OpenMLS proof-of-concept in an isolated crate, NOT a deployable chat client.
//! Per-user providers represent independent end-device key storage.
pub mod client;
#[cfg(test)]
mod tests {
    use openmls::prelude::{tls_codec::*, *};
    use openmls_basic_credential::SignatureKeyPair;
    use openmls_rust_crypto::OpenMlsRustCrypto;

    fn credential(
        id: &[u8],
        suite: Ciphersuite,
        provider: &OpenMlsRustCrypto,
    ) -> (CredentialWithKey, SignatureKeyPair) {
        let signer = SignatureKeyPair::new(suite.signature_algorithm()).unwrap();
        signer.store(provider.storage()).unwrap();
        let credential = CredentialWithKey {
            credential: BasicCredential::new(id.to_vec()).into(),
            signature_key: signer.public().into(),
        };
        (credential, signer)
    }

    fn receive(
        group: &mut MlsGroup,
        provider: &OpenMlsRustCrypto,
        message: MlsMessageOut,
    ) -> ProcessedMessage {
        let bytes = message.tls_serialize_detached().unwrap();
        let incoming = MlsMessageIn::tls_deserialize(&mut bytes.as_slice()).unwrap();
        let protocol = incoming.try_into_protocol_message().unwrap();
        group.process_message(provider, protocol).unwrap()
    }

    #[test]
    fn welcome_encrypt_exchange_and_remove_member() {
        let suite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
        let alice_provider = OpenMlsRustCrypto::default();
        let bob_provider = OpenMlsRustCrypto::default();
        let (alice_credential, alice_signer) = credential(b"Alice", suite, &alice_provider);
        let (bob_credential, bob_signer) = credential(b"Bob", suite, &bob_provider);
        let bob_key_package = KeyPackage::builder()
            .build(suite, &bob_provider, &bob_signer, bob_credential)
            .unwrap();

        let mut alice = MlsGroup::new(
            &alice_provider,
            &alice_signer,
            &MlsGroupCreateConfig::default(),
            alice_credential,
        )
        .unwrap();
        assert_eq!(alice.members().count(), 1);

        // Alice commits Bob's addition. Bob learns the epoch secrets through Welcome.
        let (_add_commit, welcome, _) = alice
            .add_members(
                &alice_provider,
                &alice_signer,
                std::slice::from_ref(bob_key_package.key_package()),
            )
            .unwrap();
        alice.merge_pending_commit(&alice_provider).unwrap();
        let serialized = welcome.tls_serialize_detached().unwrap();
        let incoming = MlsMessageIn::tls_deserialize(&mut serialized.as_slice()).unwrap();
        let welcome = match incoming.extract() {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => panic!("Expected MLS Welcome"),
        };
        let mut bob = StagedWelcome::new_from_welcome(
            &bob_provider,
            &MlsGroupJoinConfig::default(),
            welcome,
            Some(alice.export_ratchet_tree().into()),
        )
        .unwrap()
        .into_group(&bob_provider)
        .unwrap();
        assert_eq!(alice.members().count(), 2);
        assert_eq!(bob.members().count(), 2);
        assert_eq!(alice.epoch(), bob.epoch());

        let cleartext = "Hallo ÄÖÜ ß ğışç 😊 – drawing:[[10,20],[15,22]]".as_bytes();
        let ciphertext = alice
            .create_message(&alice_provider, &alice_signer, cleartext)
            .unwrap();
        let processed = receive(&mut bob, &bob_provider, ciphertext);
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app) => {
                assert_eq!(app.into_bytes(), cleartext);
            }
            _ => panic!("Expected authenticated MLS application message"),
        }

        // Removal commits must advance the epoch and invalidate the removed device.
        let bob_index = bob.own_leaf_index();
        let (remove_commit, _, _) = alice
            .remove_members(&alice_provider, &alice_signer, &[bob_index])
            .unwrap();
        alice.merge_pending_commit(&alice_provider).unwrap();
        assert_eq!(alice.members().count(), 1);
        let processed = receive(&mut bob, &bob_provider, remove_commit);
        match processed.into_content() {
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                bob.merge_staged_commit(&bob_provider, *staged).unwrap();
            }
            _ => panic!("Expected MLS membership commit"),
        }
        assert!(!bob.is_active());
        assert!(bob.create_message(&bob_provider, &bob_signer, b"revoked").is_err());
        assert!(alice.create_message(&alice_provider, &alice_signer, b"new epoch").is_ok());
    }
    #[test]
    fn three_member_removal_preserves_remaining_members_and_rejects_evicted_peer() {
        let suite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
        let ap = OpenMlsRustCrypto::default();
        let bp = OpenMlsRustCrypto::default();
        let cp = OpenMlsRustCrypto::default();
        let (ac, asigner) = credential(b"Alice", suite, &ap);
        let (bc, bsigner) = credential(b"Bob", suite, &bp);
        let (cc, csigner) = credential(b"Charlie", suite, &cp);
        let bk = KeyPackage::builder().build(suite, &bp, &bsigner, bc).unwrap();
        let ck = KeyPackage::builder().build(suite, &cp, &csigner, cc).unwrap();
        let mut alice = MlsGroup::new(&ap, &asigner, &MlsGroupCreateConfig::default(), ac).unwrap();

        let (_, bwelcome, _) = alice.add_members(
            &ap, &asigner, std::slice::from_ref(bk.key_package())
        ).unwrap();
        alice.merge_pending_commit(&ap).unwrap();
        let bbytes = bwelcome.tls_serialize_detached().unwrap();
        let welcome = match MlsMessageIn::tls_deserialize(&mut bbytes.as_slice()).unwrap().extract() {
            MlsMessageBodyIn::Welcome(w) => w,
            _ => panic!("Expected Bob Welcome"),
        };
        let mut bob = StagedWelcome::new_from_welcome(
            &bp, &MlsGroupJoinConfig::default(), welcome,
            Some(alice.export_ratchet_tree().into())
        ).unwrap().into_group(&bp).unwrap();

        let (charlie_add_commit, cwelcome, _) = alice.add_members(
            &ap, &asigner, std::slice::from_ref(ck.key_package())
        ).unwrap();
        alice.merge_pending_commit(&ap).unwrap();
        match receive(&mut bob, &bp, charlie_add_commit).into_content() {
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                bob.merge_staged_commit(&bp, *staged).unwrap();
            }
            _ => panic!("Expected Charlie add commit"),
        }
        let cbytes = cwelcome.tls_serialize_detached().unwrap();
        let welcome = match MlsMessageIn::tls_deserialize(&mut cbytes.as_slice()).unwrap().extract() {
            MlsMessageBodyIn::Welcome(w) => w,
            _ => panic!("Expected Charlie Welcome"),
        };
        let mut charlie = StagedWelcome::new_from_welcome(
            &cp, &MlsGroupJoinConfig::default(), welcome,
            Some(alice.export_ratchet_tree().into())
        ).unwrap().into_group(&cp).unwrap();
        assert_eq!(alice.members().count(), 3);
        assert_eq!(bob.members().count(), 3);
        assert_eq!(charlie.members().count(), 3);

        let previous_epoch = alice.epoch();
        let (remove_commit, _, _) = alice.remove_members(
            &ap, &asigner, &[bob.own_leaf_index()]
        ).unwrap();
        alice.merge_pending_commit(&ap).unwrap();
        let commit_bytes = remove_commit.tls_serialize_detached().unwrap();
        let first = MlsMessageIn::tls_deserialize(&mut commit_bytes.as_slice()).unwrap();
        let second = MlsMessageIn::tls_deserialize(&mut commit_bytes.as_slice()).unwrap();
        let processed = charlie.process_message(&cp, first.try_into_protocol_message().unwrap()).unwrap();
        match processed.into_content() {
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                charlie.merge_staged_commit(&cp, *staged).unwrap();
            }
            _ => panic!("Expected removal commit for Charlie"),
        }
        let processed = bob.process_message(&bp, second.try_into_protocol_message().unwrap()).unwrap();
        match processed.into_content() {
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                bob.merge_staged_commit(&bp, *staged).unwrap();
            }
            _ => panic!("Expected removal commit for Bob"),
        }
        assert_eq!(alice.members().count(), 2);
        assert_eq!(charlie.members().count(), 2);
        assert_eq!(alice.epoch(), charlie.epoch());
        assert_ne!(alice.epoch(), previous_epoch);
        assert!(!bob.is_active());

        let ciphertext = alice.create_message(
            &ap, &asigner, "After revocation: ÄÖÜ ğışç ✏️".as_bytes()
        ).unwrap();
        let wire = ciphertext.tls_serialize_detached().unwrap();
        let legit = MlsMessageIn::tls_deserialize(&mut wire.as_slice()).unwrap();
        let rejected = MlsMessageIn::tls_deserialize(&mut wire.as_slice()).unwrap();
        let received = charlie.process_message(&cp, legit.try_into_protocol_message().unwrap()).unwrap();
        match received.into_content() {
            ProcessedMessageContent::ApplicationMessage(m) => {
                assert_eq!(m.into_bytes(), "After revocation: ÄÖÜ ğışç ✏️".as_bytes());
            }
            _ => panic!("Expected encrypted application message for remaining member"),
        }
        assert!(bob.process_message(&bp, rejected.try_into_protocol_message().unwrap()).is_err());
        assert!(bob.create_message(&bp, &bsigner, b"still here").is_err());
    }

}
