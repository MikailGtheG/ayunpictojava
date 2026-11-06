//! OpenMLS proof-of-concept in an isolated crate, NOT a deployable chat client.
//! Per-user providers represent independent end-device key storage.
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
}
