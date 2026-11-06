//! Experimental in-memory transport with room-capability admission.
//! NOT end-to-end encrypted. Never expose to untrusted networks.
pub mod auth;
use std::{collections::HashMap, sync::{Arc, Mutex, Weak}};
use tokio::sync::{broadcast, OwnedSemaphorePermit, Semaphore};

pub const MAX_FRAME_BYTES: usize = 16 * 1024;
/// Protocol v2 signed-message wire envelope: version byte + 96-bit IV + >=128-bit GCM tag.
pub const MIN_ENVELOPE_BYTES: usize = 1 + 12 + 16;
/// MLS transport framing: [version=3, kind=1..=4, opaque TLS serialized bytes].
/// The server does not decrypt or authenticate MLS content.
pub const MLS_FRAME_VERSION: u8 = 3;
pub const MLS_MIN_FRAME_BYTES: usize = 3;
pub const MLS_KIND_APPLICATION: u8 = 1;
pub const MLS_KIND_COMMIT: u8 = 2;
pub const MLS_KIND_WELCOME: u8 = 3;
pub const MLS_KIND_KEY_PACKAGE: u8 = 4;
pub const ROOM_CAPACITY: usize = 32;
pub const MAX_ACTIVE_ROOMS: usize = 256;
pub const MAX_PARTICIPANTS_PER_ROOM: usize = 16;

pub struct Room {
    sender: broadcast::Sender<Vec<u8>>,
    participants: Arc<Semaphore>,
}

impl Room {
    /// Reserve one live connection slot; releasing the permit frees it automatically.
    pub fn try_enter(&self) -> Result<OwnedSemaphorePermit, &'static str> {
        self.participants.clone().try_acquire_owned().map_err(|_| "room full")
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
        self.sender.subscribe()
    }

    pub fn publish(&self, payload: Vec<u8>) -> Result<(), &'static str> {
        if !valid_envelope(&payload) {
            return Err("invalid frame size");
        }
        // No persistence: if no receiver exists, the message is dropped.
        let _ = self.sender.send(payload);
        Ok(())
    }
}

/// Checks wire format only. It cannot authenticate ciphertext; that is done by the client.
pub fn valid_envelope(bytes: &[u8]) -> bool {
    if bytes.len() > MAX_FRAME_BYTES { return false; }
    match bytes.first() {
        Some(2) => bytes.len() >= MIN_ENVELOPE_BYTES,
        Some(&MLS_FRAME_VERSION) => bytes.len() >= MLS_MIN_FRAME_BYTES &&
            matches!(bytes[1], MLS_KIND_APPLICATION | MLS_KIND_COMMIT | MLS_KIND_WELCOME | MLS_KIND_KEY_PACKAGE),
        _ => false,
    }
}

#[derive(Default)]
pub struct Rooms {
    rooms: Mutex<HashMap<String, Weak<Room>>>,
}

impl Rooms {
    pub fn join(&self, room_id: &str) -> Result<Arc<Room>, &'static str> {
        if room_id.len() != 32 || !room_id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
            return Err("room id must be 32 lowercase hexadecimal characters");
        }
        let mut rooms = self.rooms.lock().map_err(|_| "room lock poisoned")?;
        // Remove names for inactive rooms, without storing message history.
        rooms.retain(|_, room| room.strong_count() > 0);
        if let Some(existing) = rooms.get(room_id).and_then(Weak::upgrade) {
            return Ok(existing);
        }
        if rooms.len() >= MAX_ACTIVE_ROOMS {
            return Err("too many active rooms");
        }
        let (sender, _) = broadcast::channel(ROOM_CAPACITY);
        let room = Arc::new(Room { sender, participants: Arc::new(Semaphore::new(MAX_PARTICIPANTS_PER_ROOM)) });
        rooms.insert(room_id.to_owned(), Arc::downgrade(&room));
        Ok(room)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[tokio::test]
    async fn message_reaches_subscribers() {
        let rooms = Rooms::default();
        let room = rooms.join(ID).unwrap();
        let mut receiver = room.subscribe();
        let frame = vec![2u8; MIN_ENVELOPE_BYTES];
        room.publish(frame.clone()).unwrap();
        assert_eq!(receiver.recv().await.unwrap(), frame);
    }

    #[test]
    fn rejects_invalid_identifiers_and_frame_sizes() {
        let rooms = Rooms::default();
        assert!(rooms.join("../outside").is_err());
        assert!(rooms.join("ABCDEF0123456789ABCDEF0123456789").is_err());
        let room = rooms.join(ID).unwrap();
        assert!(room.publish(vec![]).is_err());
        assert!(room.publish(vec![2; MAX_FRAME_BYTES + 1]).is_err());
        assert!(room.publish(b"plaintext should not relay".to_vec()).is_err());
        assert!(room.publish(vec![0; MIN_ENVELOPE_BYTES]).is_err());
        assert!(room.publish(vec![2; MIN_ENVELOPE_BYTES - 1]).is_err());
        assert!(room.publish(vec![1; MIN_ENVELOPE_BYTES]).is_err());
        assert!(room.publish(vec![2; MIN_ENVELOPE_BYTES]).is_ok());
        assert!(room.publish(vec![3, MLS_KIND_APPLICATION, 42]).is_ok());
        assert!(room.publish(vec![3, MLS_KIND_COMMIT, 42]).is_ok());
        assert!(room.publish(vec![3, MLS_KIND_WELCOME, 42]).is_ok());
        assert!(room.publish(vec![3, MLS_KIND_KEY_PACKAGE, 42]).is_ok());
        assert!(room.publish(vec![3, 0, 42]).is_err());
        assert!(room.publish(vec![3, 5, 42]).is_err());
        assert!(room.publish(vec![3, 1]).is_err());
        assert!(room.publish(vec![3, 1, 42].into_iter().chain(vec![0u8; MAX_FRAME_BYTES].into_iter()).collect()).is_err());
    }

    #[test]
    fn enforces_room_limit_and_reclaims_inactive_rooms() {
        let rooms = Rooms::default();
        let mut active = Vec::new();
        for i in 0..MAX_ACTIVE_ROOMS {
            active.push(rooms.join(&format!("{i:032x}")).unwrap());
        }
        assert!(rooms.join(&format!("{:032x}", MAX_ACTIVE_ROOMS)).is_err());
        active.pop();
        assert!(rooms.join(&format!("{:032x}", MAX_ACTIVE_ROOMS)).is_ok());
    }

    #[test]
    fn room_has_sixteen_slots_and_releases_on_disconnect() {
        let room = Rooms::default().join(ID).unwrap();
        let mut participants = Vec::new();
        for _ in 0..MAX_PARTICIPANTS_PER_ROOM {
            participants.push(room.try_enter().unwrap());
        }
        assert!(room.try_enter().is_err());
        participants.pop();
        assert!(room.try_enter().is_ok());
    }

    #[test]
    fn independent_rooms_have_independent_limits() {
        let rooms = Rooms::default();
        let first = rooms.join(ID).unwrap();
        let another = rooms.join("ffffffffffffffffffffffffffffffff").unwrap();
        let _permits: Vec<_> = (0..MAX_PARTICIPANTS_PER_ROOM)
            .map(|_| first.try_enter().unwrap())
            .collect();
        assert!(first.try_enter().is_err());
        assert!(another.try_enter().is_ok());
    }

    #[test]
    fn releases_room_on_last_disconnect() {
        let rooms = Rooms::default();
        let first = rooms.join(ID).unwrap();
        let weak = Arc::downgrade(&first);
        let second = rooms.join(ID).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        drop(first);
        drop(second);
        assert!(weak.upgrade().is_none());
        assert!(rooms.join(ID).is_ok());
    }
}
