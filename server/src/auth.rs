//! HMAC-based room capability admission, NOT end-to-end encryption.
//! The relay knows the capability verifier secret and can admit peers.
//! Possession of a room token confers access until the root secret rotates.
use hmac::{Hmac, Mac};
use sha2::Sha256;

pub const ROOM_ID_LENGTH: usize = 32;
const TOKEN_BYTES: usize = 32;
const DOMAIN: &[u8] = b"pictochat-room-capability-v1:";

pub fn valid_room_id(room: &str) -> bool {
    room.len() == ROOM_ID_LENGTH
        && room.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub struct RoomAuth {
    secret: [u8; TOKEN_BYTES],
}

impl RoomAuth {
    pub fn from_hex(value: &str) -> Result<Self, &'static str> {
        let mut secret = [0u8; TOKEN_BYTES];
        hex::decode_to_slice(value, &mut secret)
            .map_err(|_| "PICTOCHAT_RELAY_SECRET must be exactly 64 hexadecimal digits")?;
        Ok(Self { secret })
    }

    fn mac(&self, room: &str) -> Result<Hmac<Sha256>, &'static str> {
        if !valid_room_id(room) {
            return Err("invalid room identifier");
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.secret)
            .map_err(|_| "invalid HMAC key")?;
        mac.update(DOMAIN);
        mac.update(room.as_bytes());
        Ok(mac)
    }

    /// Used by the local administrator to issue a room admission capability.
    pub fn issue(&self, room: &str) -> Result<String, &'static str> {
        Ok(hex::encode(self.mac(room)?.finalize().into_bytes()))
    }

    /// The MAC crate verifies tags in constant time (for valid tag lengths).
    pub fn verify(&self, room: &str, token: &str) -> bool {
        let mut tag = [0u8; TOKEN_BYTES];
        if hex::decode_to_slice(token, &mut tag).is_err() {
            return false;
        }
        self.mac(room)
            .is_ok_and(|mac| mac.verify_slice(&tag).is_ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const ROOM: &str = "0123456789abcdef0123456789abcdef";
    const OTHER: &str = "ffffffffffffffffffffffffffffffff";

    #[test]
    fn grants_only_correct_room() {
        let auth = RoomAuth::from_hex(KEY).unwrap();
        let token = auth.issue(ROOM).unwrap();
        assert_eq!(token.len(), 64);
        assert!(auth.verify(ROOM, &token));
        assert!(!auth.verify(OTHER, &token));
        assert!(!auth.verify(ROOM, &"00".repeat(32)));
        assert!(!auth.verify(ROOM, "bad"));
    }

    #[test]
    fn rejects_bad_secrets_and_room_ids() {
        assert!(RoomAuth::from_hex("abcd").is_err());
        assert!(RoomAuth::from_hex(&"nothex".repeat(11)).is_err());
        let auth = RoomAuth::from_hex(KEY).unwrap();
        assert!(auth.issue("../../evil").is_err());
        assert!(auth.issue("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF").is_err());
    }

    #[test]
    fn rotation_invalidates_existing_tokens() {
        let first = RoomAuth::from_hex(KEY).unwrap();
        let second = RoomAuth::from_hex(&"aa".repeat(32)).unwrap();
        let token = first.issue(ROOM).unwrap();
        assert!(!second.verify(ROOM, &token));
    }
}
