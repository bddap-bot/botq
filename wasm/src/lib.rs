//! botq-dash-wasm — browser (wasm32) iroh client for the botq dashboard.
//!
//! Relay-only by construction: in a browser iroh cannot open UDP sockets, so the
//! N0 endpoint preset's only viable path is WebSocket → relay → native node. The
//! connection is e2e-encrypted to the node's public key (carried in the ticket),
//! so no CA/DNS trust is involved (MITM-proof past the GH-Pages bootstrap).
//!
//! Proves the API + toolchain for the dashboard spec's `wasm/` wrapper crate.
//! Single-threaded wasm: state lives in thread-locals; nothing needs `Send`.

use std::cell::RefCell;

use anyhow::{anyhow, Context, Result};
use iroh::{
    endpoint::Connection, Endpoint, EndpointAddr, EndpointId, RelayUrl,
};
use wasm_bindgen::prelude::*;

/// ALPN for the dashboard protocol (matches Half B's `botq dash` acceptor).
const ALPN: &[u8] = b"botq-dash/0";

thread_local! {
    static ENDPOINT: RefCell<Option<Endpoint>> = const { RefCell::new(None) };
    static CONN: RefCell<Option<Connection>> = const { RefCell::new(None) };
    // One long-lived bi-stream carries auth + all request/response frames.
    static SEND: RefCell<Option<iroh::endpoint::SendStream>> = const { RefCell::new(None) };
    static RECV: RefCell<Option<iroh::endpoint::RecvStream>> = const { RefCell::new(None) };
}

fn js_err(e: impl Into<anyhow::Error>) -> JsError {
    JsError::new(&e.into().to_string())
}

/// Install panic hook + tracing. Call once at startup. (`#[wasm_bindgen(start)]`
/// would run it automatically; exposed explicitly so the bootstrap controls timing.)
#[wasm_bindgen]
pub fn init() {
    console_error_panic_hook::set_once();
    // A no-time, no-ansi subscriber is required in the browser or tracing panics.
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::level_filters::LevelFilter::INFO)
        .without_time()
        .with_ansi(false)
        .try_init();
    tracing::info!("botq-dash-wasm init");
}

/// Build the wasm endpoint with the N0 preset (default relay map + discovery).
/// In the browser this yields a relay-only endpoint automatically.
async fn ensure_endpoint() -> Result<Endpoint> {
    if let Some(ep) = ENDPOINT.with(|e| e.borrow().clone()) {
        return Ok(ep);
    }
    let ep = Endpoint::builder(iroh::endpoint::presets::N0)
        .bind()
        .await
        .context("endpoint bind failed")?;
    ENDPOINT.with(|e| *e.borrow_mut() = Some(ep.clone()));
    Ok(ep)
}

/// Connect to the native botq node and open the bi-stream.
///
/// iroh 1.0 has NO built-in ticket type (tickets were removed from the core crates;
/// `iroh-base` 1.0 has no `Ticket`). So the dashboard token carries the two fields a
/// ticket used to wrap — the node's `EndpointId` and its `RelayUrl` — which we rebuild
/// into an `EndpointAddr` here. Format: `"<endpoint_id>@<relay_url>"`, or a bare
/// `"<endpoint_id>"` (relay then discovered via the N0 preset's pkarr/DNS discovery).
#[wasm_bindgen]
pub async fn connect(ticket: &str) -> Result<(), JsError> {
    connect_inner(ticket).await.map_err(js_err)
}

async fn connect_inner(ticket: &str) -> Result<()> {
    let ep = ensure_endpoint().await?;
    let addr = parse_addr(ticket)?;

    // `connect` takes `impl Into<EndpointAddr>`; the relay URL in the addr is what
    // the browser uses (no UDP path is possible in wasm, so it's relay-only).
    let conn = ep
        .connect(addr, ALPN)
        .await
        .context("iroh connect failed")?;

    let (send, recv) = conn.open_bi().await.context("open_bi failed")?;

    CONN.with(|c| *c.borrow_mut() = Some(conn));
    SEND.with(|s| *s.borrow_mut() = Some(send));
    RECV.with(|r| *r.borrow_mut() = Some(recv));
    Ok(())
}

/// Build the connect target from the token's `"<endpoint_id>[@<relay_url>]"` form.
fn parse_addr(s: &str) -> Result<EndpointAddr> {
    let (id_str, relay) = match s.split_once('@') {
        Some((id, url)) => (id, Some(url)),
        None => (s, None),
    };
    let id: EndpointId = id_str.parse().context("invalid endpoint id")?;
    let addr = EndpointAddr::new(id);
    Ok(match relay {
        Some(url) => addr.with_relay_url(url.parse::<RelayUrl>().context("invalid relay url")?),
        None => addr,
    })
}

/// Send one length-prefixed request frame, return the response frame's bytes.
#[wasm_bindgen]
pub async fn send(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    send_frame(bytes).await.map_err(js_err)?;
    recv_frame().await.map_err(js_err)
}

/// Receive one length-prefixed frame from the stream (e.g. a pushed delta).
#[wasm_bindgen]
pub async fn recv() -> Result<Vec<u8>, JsError> {
    recv_frame().await.map_err(js_err)
}

/// Send one length-prefixed frame and DO NOT wait for a reply — a fire-and-forget
/// owner→server write. `send` (above) always awaits a response on the SAME bi-stream,
/// so it can't be used while a subscription monopolizes the recv half with its push
/// loop; `send_only` writes on the send half ONLY, so the dashboard can post owner
/// writes (a triage message / a worker instruct) WHILE subscribed without racing the
/// pushed deltas the recv loop is consuming.
#[wasm_bindgen]
pub async fn send_only(bytes: &[u8]) -> Result<(), JsError> {
    send_frame(bytes).await.map_err(js_err)
}

async fn send_frame(bytes: &[u8]) -> Result<()> {
    let len = u32::try_from(bytes.len()).context("frame too large")?;
    SEND.with(|s| -> Result<_> {
        let mut b = s.borrow_mut();
        let _ = b.as_mut().ok_or_else(|| anyhow!("not connected"))?;
        Ok(())
    })?;
    // Take the stream out to await without holding the RefCell borrow across .await.
    let mut stream = SEND
        .with(|s| s.borrow_mut().take())
        .ok_or_else(|| anyhow!("not connected"))?;
    let r = async {
        stream.write_all(&len.to_le_bytes()).await?;
        stream.write_all(bytes).await?;
        anyhow::Ok(())
    }
    .await;
    SEND.with(|s| *s.borrow_mut() = Some(stream));
    r.context("write frame failed")
}

async fn recv_frame() -> Result<Vec<u8>> {
    let mut stream = RECV
        .with(|r| r.borrow_mut().take())
        .ok_or_else(|| anyhow!("not connected"))?;
    let r = async {
        let mut len_buf = [0u8; 4];
        stream.read_exact(&mut len_buf).await?;
        let len = u32::from_le_bytes(len_buf) as usize;
        let mut buf = vec![0u8; len];
        stream.read_exact(&mut buf).await?;
        anyhow::Ok(buf)
    }
    .await;
    RECV.with(|r| *r.borrow_mut() = Some(stream));
    r.context("read frame failed")
}
