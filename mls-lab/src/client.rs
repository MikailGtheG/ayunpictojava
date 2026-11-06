//! Experimental endpoint-owned MLS state. The relay never holds these objects.
//! Volatile-only client state: no account recovery, persistence, or credential trust yet.
use openmls::prelude::{tls_codec::*, *};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;

pub const CIPHER_SUITE: Ciphersuite =
    Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
pub const FRAME_VERSION: u8 = 3;
pub const KIND_APPLICATION: u8 = 1;
pub const KIND_COMMIT: u8 = 2;
pub const KIND_WELCOME: u8 = 3;
pub const KIND_KEY_PACKAGE: u8 = 4;
pub const MAX_WIRE_SIZE: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incoming {
    Application(Vec<u8>),
    MembershipChanged,
    Removed,
}

pub fn wrap(kind: u8, data: Vec<u8>) -> Result<Vec<u8>, &'static str> {
    if !matches!(kind, KIND_APPLICATION | KIND_COMMIT | KIND_WELCOME | KIND_KEY_PACKAGE)
        || data.is_empty() || data.len() + 2 > MAX_WIRE_SIZE
    {
        return Err("invalid MLS transport envelope");
    }
    let mut out = Vec::with_capacity(data.len() + 2);
    out.extend_from_slice(&[FRAME_VERSION, kind]);
    out.extend(data);
    Ok(out)
}
pub fn unwrap(frame: &[u8], kind: u8) -> Result<MlsMessageIn, &'static str> {
    if frame.len() < 3 || frame.len() > MAX_WIRE_SIZE
        || frame[0] != FRAME_VERSION || frame[1] != kind
    {
        return Err("wrong MLS envelope version or kind");
    }
    MlsMessageIn::tls_deserialize(&mut &frame[2..]).map_err(|_| "invalid MLS TLS encoding")
}

pub struct Client {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    group: Option<MlsGroup>,
}

impl Client {
    pub fn new(label: &[u8]) -> Self {
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(CIPHER_SUITE.signature_algorithm())
            .expect("supported signature algorithm");
        signer.store(provider.storage()).expect("in-memory key storage");
        let credential = CredentialWithKey {
            credential: BasicCredential::new(label.to_vec()).into(),
            signature_key: signer.public().into(),
        };
        Self { provider, signer, credential, group: None }
    }

    pub fn key_package(&self) -> KeyPackage {
        KeyPackage::builder().build(
            CIPHER_SUITE, &self.provider, &self.signer, self.credential.clone()
        ).expect("key package generation")
    }

    pub fn start_group(&mut self) {
        assert!(self.group.is_none(), "group already initialized");
        self.group = Some(MlsGroup::new(
            &self.provider, &self.signer,
            &MlsGroupCreateConfig::default(), self.credential.clone()
        ).expect("MLS group creation"));
    }

    pub fn add(&mut self, package: &KeyPackage) -> (Vec<u8>, Vec<u8>) {
        let group = self.group.as_mut().expect("client needs a group");
        let (commit, welcome, _) = group.add_members(
            &self.provider, &self.signer, std::slice::from_ref(package)
        ).expect("MLS add");
        group.merge_pending_commit(&self.provider).expect("MLS add commit");
        (
            wrap(KIND_COMMIT, commit.tls_serialize_detached().expect("serialize commit")).expect("bounded commit"),
            wrap(KIND_WELCOME, welcome.tls_serialize_detached().expect("serialize welcome")).expect("bounded welcome"),
        )
    }

    pub fn accept_welcome(&mut self, wire: &[u8], tree: RatchetTreeIn) {
        assert!(self.group.is_none(), "group already initialized");
        let welcome = match unwrap(wire, KIND_WELCOME).expect("valid transport").extract() {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => panic!("not an MLS Welcome"),
        };
        self.group = Some(StagedWelcome::new_from_welcome(
            &self.provider, &MlsGroupJoinConfig::default(), welcome, Some(tree)
        ).expect("MLS Welcome must authenticate").into_group(&self.provider).expect("join MLS group"));
    }

    pub fn send(&mut self, message: &[u8]) -> Vec<u8> {
        let group = self.group.as_mut().expect("client needs group");
        let encrypted = group.create_message(&self.provider, &self.signer, message)
            .expect("MLS encrypt");
        wrap(KIND_APPLICATION, encrypted.tls_serialize_detached().expect("serialize MLS ciphertext"))
            .expect("bounded MLS packet")
    }

    pub fn process(&mut self, wire: &[u8], kind: u8) -> Result<Incoming, &'static str> {
        if !matches!(kind, KIND_APPLICATION | KIND_COMMIT) {
            return Err("not a processable MLS message");
        }
        let protocol = unwrap(wire, kind)?
            .try_into_protocol_message().map_err(|_| "not a protocol message")?;
        let group = self.group.as_mut().ok_or("no joined MLS group")?;
        let processed = group.process_message(&self.provider, protocol)
            .map_err(|_| "MLS message invalid for this member or epoch")?;
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(message) if kind == KIND_APPLICATION =>
                Ok(Incoming::Application(message.into_bytes())),
            ProcessedMessageContent::StagedCommitMessage(staged) if kind == KIND_COMMIT => {
                group.merge_staged_commit(&self.provider, *staged)
                    .map_err(|_| "cannot merge MLS commit")?;
                if group.is_active() { Ok(Incoming::MembershipChanged) }
                else { Ok(Incoming::Removed) }
            }
            _ => Err("message type does not match wire kind"),
        }
    }

    pub fn remove(&mut self, leaf: LeafNodeIndex) -> Vec<u8> {
        let group = self.group.as_mut().expect("group needed");
        let (commit, _, _) = group.remove_members(&self.provider, &self.signer, &[leaf])
            .expect("member removal");
        group.merge_pending_commit(&self.provider).expect("merge removal");
        wrap(KIND_COMMIT, commit.tls_serialize_detached().expect("serialize removal"))
            .expect("bounded removal frame")
    }

    pub fn own_leaf(&self) -> LeafNodeIndex {
        self.group.as_ref().expect("group needed").own_leaf_index()
    }
    pub fn epoch(&self) -> u64 {
        self.group.as_ref().expect("group needed").epoch().as_u64()
    }
    pub fn count(&self) -> usize {
        self.group.as_ref().expect("group needed").members().count()
    }
    pub fn active(&self) -> bool {
        self.group.as_ref().expect("group needed").is_active()
    }
    pub fn ratchet_tree(&self) -> RatchetTreeIn {
        self.group.as_ref().expect("group needed").export_ratchet_tree().into()
    }
}
