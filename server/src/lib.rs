//! Experimental in-memory transport. NOT encrypted or authenticated.
//! Never expose to an untrusted network until membership + E2EE are implemented.
use std::{collections::HashMap, sync::{Arc, Mutex, Weak}};
use tokio::sync::broadcast;

pub const MAX_FRAME_BYTES: usize = 16 * 1024;
pub const ROOM_CAPACITY: usize = 32;
pub const MAX_ACTIVE_ROOMS: usize = 256;

pub struct Room {
    sender: broadcast::Sender<Vec<u8>>,
}

impl Room {
    pub fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
        self.sender.subscribe()
    }

    pub fn publish(&self, payload: Vec<u8>) -> Result<(), &'static str> {
        if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
            return Err("invalid frame size");
        }
        // No persistence: if no receiver exists, the message is dropped.
        let _ = self.sender.send(payload);
        Ok(())
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
        let room = Arc::new(Room { sender });
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
        room.publish(b"opaque payload".to_vec()).unwrap();
        assert_eq!(receiver.recv().await.unwrap(), b"opaque payload");
    }

    #[test]
    fn rejects_invalid_identifiers_and_frame_sizes() {
        let rooms = Rooms::default();
        assert!(rooms.join("../outside").is_err());
        assert!(rooms.join("ABCDEF0123456789ABCDEF0123456789").is_err());
        let room = rooms.join(ID).unwrap();
        assert!(room.publish(vec![]).is_err());
        assert!(room.publish(vec![1; MAX_FRAME_BYTES + 1]).is_err());
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
