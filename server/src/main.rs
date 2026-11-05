//! Development-only loopback WebSocket relay.
//! No cryptography, user identity, room authorization, or TLS yet.
use std::{net::SocketAddr, sync::Arc, time::{Duration, Instant}};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{header::ORIGIN, HeaderMap, StatusCode},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use pictochat_relay::{Rooms, MAX_FRAME_BYTES};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAX_CONNECTIONS: usize = 128;
const MAX_MESSAGES_PER_SECOND: u32 = 20;

#[derive(Clone)]
struct AppState {
    rooms: Arc<Rooms>,
    slots: Arc<Semaphore>,
}

// Fixed one-second quota per session, including clients on the same room.
struct MessageQuota {
    window_start: Instant,
    accepted: u32,
}

impl MessageQuota {
    fn new() -> Self {
        Self { window_start: Instant::now(), accepted: 0 }
    }

    fn permit(&mut self, now: Instant) -> bool {
        if now.duration_since(self.window_start) >= Duration::from_secs(1) {
            self.window_start = now;
            self.accepted = 0;
        }
        if self.accepted >= MAX_MESSAGES_PER_SECOND { return false; }
        self.accepted += 1;
        true
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let state = AppState {
        rooms: Arc::new(Rooms::default()),
        slots: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
    };
    let app = Router::new()
        .route("/ws/{room_id}", get(connect))
        .with_state(state);
    // Bind exclusively to loopback until the protocol is authenticated and E2EE.
    let addr = SocketAddr::from(([127, 0, 0, 1], 8787));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("EXPERIMENTAL INSECURE relay listening at {addr} (loopback only)");
    axum::serve(listener, app).await
}

async fn connect(
    State(state): State<AppState>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<axum::response::Response, StatusCode> {
    if !origin_is_allowed(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let permit = state.slots.clone().try_acquire_owned()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let room = state.rooms.join(&room_id).map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(ws.max_message_size(MAX_FRAME_BYTES).max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| session(socket, room, permit)))
}

async fn session(socket: WebSocket, room: Arc<pictochat_relay::Room>, _permit: OwnedSemaphorePermit) {
    let (mut outgoing, mut incoming) = socket.split();
    let mut receiver = room.subscribe();
    let mut quota = MessageQuota::new();
    loop {
        tokio::select! {
            received = incoming.next() => {
                match received {
                    Some(Ok(Message::Binary(data))) => {
                        if !quota.permit(Instant::now()) || room.publish(data.to_vec()).is_err() { break; }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Text(_))) => break, // ciphertext frames must be binary
                    _ => {}
                }
            }
            delivered = receiver.recv() => {
                match delivered {
                    Ok(payload) => {
                        if outgoing.send(Message::Binary(payload.into())).await.is_err() { break; }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => break,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}


// Browsers always send Origin on WebSocket handshakes; CLI clients may omit it.
// This is CSWSH protection, NOT authentication or authorization.
fn origin_is_allowed(headers: &HeaderMap) -> bool {
    match headers.get(ORIGIN) {
        None => true,
        Some(origin) => matches!(
            origin.to_str(),
            Ok("http://127.0.0.1:8787" | "http://localhost:8787")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn forbids_foreign_browser_origins() {
        let mut headers = HeaderMap::new();
        headers.insert(ORIGIN, HeaderValue::from_static("https://evil.example"));
        assert!(!origin_is_allowed(&headers));
        headers.insert(ORIGIN, HeaderValue::from_static("null"));
        assert!(!origin_is_allowed(&headers));
        headers.insert(ORIGIN, HeaderValue::from_static("http://localhost:8787"));
        assert!(origin_is_allowed(&headers));
        headers.insert(ORIGIN, HeaderValue::from_static("http://127.0.0.1:8787"));
        assert!(origin_is_allowed(&headers));
    }

    #[test]
    fn session_quota_enforces_rate_and_resets() {
        let mut quota = MessageQuota::new();
        let start = quota.window_start;
        for _ in 0..MAX_MESSAGES_PER_SECOND {
            assert!(quota.permit(start));
        }
        assert!(!quota.permit(start));
        assert!(quota.permit(start + Duration::from_secs(1)));
    }

    #[tokio::test]
    async fn session_slots_are_bounded_and_released() {
        let slots = Arc::new(Semaphore::new(1));
        let first = slots.clone().try_acquire_owned().unwrap();
        assert!(slots.clone().try_acquire_owned().is_err());
        drop(first);
        assert!(slots.clone().try_acquire_owned().is_ok());
    }

    #[test]
    fn permits_headless_client_without_origin() {
        assert!(origin_is_allowed(&HeaderMap::new()));
    }
}
