//! Development-only loopback WebSocket relay.
//! No cryptography, user identity, room authorization, or TLS yet.
use std::{net::SocketAddr, sync::Arc, time::{Duration, Instant}};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{header::{ORIGIN, SEC_WEBSOCKET_PROTOCOL}, HeaderMap, StatusCode},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use pictochat_relay::{auth::RoomAuth, Rooms, MAX_FRAME_BYTES};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAX_CONNECTIONS: usize = 128;
const MAX_MESSAGES_PER_SECOND: u32 = 20;

#[derive(Clone)]
struct AppState {
    rooms: Arc<Rooms>,
    slots: Arc<Semaphore>,
    auth: Arc<RoomAuth>,
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
    let secret = std::env::var("PICTOCHAT_RELAY_SECRET")
        .map_err(|_| std::io::Error::other("set PICTOCHAT_RELAY_SECRET to 64 hex digits"))?;
    let auth = Arc::new(RoomAuth::from_hex(&secret).map_err(std::io::Error::other)?);
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 3 && args[1] == "invite" {
        let token = auth.issue(&args[2]).map_err(std::io::Error::other)?;
        println!("{token}");
        return Ok(());
    }
    if args.len() != 1 {
        return Err(std::io::Error::other("usage: cargo run -- [invite 32-hex-room-id]"));
    }
    let state = AppState {
        rooms: Arc::new(Rooms::default()),
        slots: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
        auth,
    };
    let app = router(state);
    // Bind exclusively to loopback until the protocol is authenticated and E2EE.
    let addr = SocketAddr::from(([127, 0, 0, 1], 8787));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("EXPERIMENTAL INSECURE relay listening at {addr} (loopback only)");
    axum::serve(listener, app).await
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(dev_home))
        .route("/crypto.mjs", get(crypto_module))
        .route("/ws/{room_id}", get(connect))
        .with_state(state)
}

async fn crypto_module() -> ([(axum::http::header::HeaderName, &'static str); 2], &'static str) {
    (
        [
            (axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
        include_str!("../public/crypto.mjs"),
    )
}

async fn dev_home() -> ([(axum::http::header::HeaderName, &'static str); 5], &'static str) {
    (
        [
            (axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
            (axum::http::header::CONTENT_SECURITY_POLICY, "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src ws://127.0.0.1:8787 ws://localhost:8787; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
            (axum::http::header::REFERRER_POLICY, "no-referrer"),
            (axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        include_str!("../public/index.html"),
    )
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
    if !room_capability_valid(&headers, &room_id, &state.auth) {
        return Err(StatusCode::FORBIDDEN);
    }
    let permit = state.slots.clone().try_acquire_owned()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let room = state.rooms.join(&room_id).map_err(|_| StatusCode::BAD_REQUEST)?;
    let room_permit = room.try_enter().map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(ws.protocols(["picto.v1"]).max_message_size(MAX_FRAME_BYTES).max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| session(socket, room, permit, room_permit)))
}

async fn session(socket: WebSocket, room: Arc<pictochat_relay::Room>, _permit: OwnedSemaphorePermit, _room_permit: OwnedSemaphorePermit) {
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



// The browser sends both subprotocol values; only the public protocol identifier
// is echoed. The admission token is never placed in a URL or echoed to the client.
// This is bearer-token room admission, not participant identity nor E2EE.
fn room_capability_valid(headers: &HeaderMap, room: &str, auth: &RoomAuth) -> bool {
    let mut saw_protocol = false;
    let mut candidate: Option<&str> = None;
    for header in headers.get_all(SEC_WEBSOCKET_PROTOCOL).iter() {
        let Ok(header) = header.to_str() else { return false; };
        for part in header.split(',').map(str::trim) {
            if part == "picto.v1" {
                if saw_protocol { return false; }
                saw_protocol = true;
            } else if let Some(value) = part.strip_prefix("auth.") {
                if candidate.is_some() { return false; }
                candidate = Some(value);
            } else {
                return false;
            }
        }
    }
    saw_protocol && candidate.is_some_and(|token| auth.verify(room, token))
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
    fn local_dev_page_contains_no_external_resources_and_has_pdf_action() {
        let html = include_str!("../public/index.html");
        assert!(html.contains("window.print()"));
        assert!(html.contains("ÄÖÜ"));
        assert!(html.contains("EXPERIMENTELLE AES-256-GCM-VERSCHLÜSSELUNG"));
        assert!(html.contains("encryptPacket("));
        assert!(html.contains("decryptPacket("));
        assert!(!html.contains("https://"));
        assert!(!html.contains("http://"));
        assert!(!html.contains("localStorage"));
    }

    #[tokio::test]
    async fn real_websocket_rejects_wrong_capability_and_relays_for_valid_peers() {
        use tokio_tungstenite::{connect_async, tungstenite::{client::IntoClientRequest, Message as ClientMessage}};
        use tokio::time::{timeout, Duration};

        let auth = Arc::new(RoomAuth::from_hex(&"11".repeat(32)).unwrap());
        let room = "0123456789abcdef0123456789abcdef";
        let token = auth.issue(room).unwrap();
        let state = AppState {
            rooms: Arc::new(Rooms::default()),
            slots: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            auth,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router(state)).await.unwrap();
        });
        let url = format!("ws://{address}/ws/{room}");

        let make_request = |capability: &str| {
            let mut request = url.as_str().into_client_request().unwrap();
            request.headers_mut().insert(
                SEC_WEBSOCKET_PROTOCOL,
                format!("picto.v1, auth.{capability}").parse().unwrap()
            );
            request
        };

        let invalid = timeout(Duration::from_secs(3), connect_async(make_request(&"00".repeat(32))))
            .await.unwrap();
        assert!(matches!(invalid, Err(tokio_tungstenite::tungstenite::Error::Http(response))
            if response.status() == StatusCode::FORBIDDEN));

        let (mut alice, alice_response) = timeout(Duration::from_secs(3), connect_async(make_request(&token)))
            .await.unwrap().unwrap();
        assert_eq!(alice_response.headers().get(SEC_WEBSOCKET_PROTOCOL).unwrap(), "picto.v1");
        let (mut bob, _) = timeout(Duration::from_secs(3), connect_async(make_request(&token)))
            .await.unwrap().unwrap();
        let envelope = vec![1u8; pictochat_relay::MIN_ENVELOPE_BYTES];
        alice.send(ClientMessage::Binary(envelope.clone().into())).await.unwrap();
        let received = timeout(Duration::from_secs(3), bob.next()).await.unwrap().unwrap().unwrap();
        assert_eq!(received.into_data().as_ref(), envelope.as_slice());
        server.abort();
    }

    #[test]
    fn room_admission_requires_exact_capability() {
        let auth = RoomAuth::from_hex(&"11".repeat(32)).unwrap();
        let room = "0123456789abcdef0123456789abcdef";
        let other = "ffffffffffffffffffffffffffffffff";
        let token = auth.issue(room).unwrap();
        let mut headers = HeaderMap::new();
        assert!(!room_capability_valid(&headers, room, &auth));
        headers.insert(SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_str(&format!("picto.v1, auth.{token}")).unwrap());
        assert!(room_capability_valid(&headers, room, &auth));
        assert!(!room_capability_valid(&headers, other, &auth));
        headers.insert(SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_static("picto.v1, auth.bad"));
        assert!(!room_capability_valid(&headers, room, &auth));
        headers.insert(SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_str(&format!("picto.v1, auth.{token}, auth.{token}")).unwrap());
        assert!(!room_capability_valid(&headers, room, &auth));
    }

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
