//! Development-only loopback WebSocket relay.
//! No cryptography, user identity, room authorization, or TLS yet.
use std::{net::SocketAddr, sync::Arc};
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

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let app = Router::new()
        .route("/ws/{room_id}", get(connect))
        .with_state(Arc::new(Rooms::default()));
    // Bind exclusively to loopback until the protocol is authenticated and E2EE.
    let addr = SocketAddr::from(([127, 0, 0, 1], 8787));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("EXPERIMENTAL INSECURE relay listening at {addr} (loopback only)");
    axum::serve(listener, app).await
}

async fn connect(
    State(rooms): State<Arc<Rooms>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<axum::response::Response, StatusCode> {
    if !origin_is_allowed(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let room = rooms.join(&room_id).map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(ws.max_message_size(MAX_FRAME_BYTES).max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| session(socket, room)))
}

async fn session(socket: WebSocket, room: Arc<pictochat_relay::Room>) {
    let (mut outgoing, mut incoming) = socket.split();
    let mut receiver = room.subscribe();
    loop {
        tokio::select! {
            received = incoming.next() => {
                match received {
                    Some(Ok(Message::Binary(data))) => {
                        if room.publish(data.to_vec()).is_err() { break; }
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
    fn permits_headless_client_without_origin() {
        assert!(origin_is_allowed(&HeaderMap::new()));
    }
}
