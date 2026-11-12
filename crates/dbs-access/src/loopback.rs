//! Browser sign-in helper for providers that use an authorization code with PKCE
//! over a loopback redirect:
//!
//! 1. Bind `127.0.0.1:<random port>`, generate a PKCE verifier (S256) and a state.
//! 2. The provider builds its start URL (adding [`Loopback::append_params`]) and the
//!    system browser opens it; the provider runs its single sign-on and redirects to
//!    `http://127.0.0.1:<port>/callback?code=…&state=…`.
//! 3. The listener checks the state, shows a short "signed in" page and stops.
//! 4. The provider exchanges code + verifier for a session token.

use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

use crate::{AccessError, AccessResult, SignInContext};

/// How long the browser step may take.
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// RFC 4648 base64url without padding.
pub fn b64url(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..=c.len() {
            out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

fn random_b64(n: usize) -> String {
    let mut b = vec![0u8; n];
    getrandom::getrandom(&mut b).expect("OS RNG unavailable");
    b64url(&b)
}

/// S256 code challenge for a verifier.
pub fn challenge_for(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    pub fn new() -> Self {
        let verifier = random_b64(32); // 43 chars, within RFC 7636's 43..128
        let challenge = challenge_for(&verifier);
        Pkce { verifier, challenge }
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Self::new()
    }
}

/// One sign-in attempt: the loopback listener plus its PKCE pair and state.
pub struct Loopback {
    listener: TcpListener,
    port: u16,
    pub state: String,
    pub pkce: Pkce,
}

impl Loopback {
    pub async fn bind() -> AccessResult<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| AccessError::Other(format!("could not start the sign-in listener: {e}")))?;
        let port = listener.local_addr().map_err(|e| AccessError::Other(e.to_string()))?.port();
        Ok(Loopback { listener, port, state: random_b64(24), pkce: Pkce::new() })
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback", self.port)
    }

    /// Adds `redirect_uri`, `state`, `code_challenge` and `code_challenge_method=S256`.
    pub fn append_params(&self, url: &mut url::Url) {
        url.query_pairs_mut()
            .append_pair("redirect_uri", &self.redirect_uri())
            .append_pair("state", &self.state)
            .append_pair("code_challenge", &self.pkce.challenge)
            .append_pair("code_challenge_method", "S256");
    }

    /// Waits for the browser to come back with `?code=…&state=…`. Other paths
    /// (e.g. `/favicon.ico`) get a 404 and the wait goes on.
    pub async fn wait_for_code(&self, cancel: &CancellationToken, timeout: Duration) -> AccessResult<String> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let (mut sock, _) = tokio::select! {
                _ = cancel.cancelled() => return Err(AccessError::Cancelled),
                _ = tokio::time::sleep_until(deadline) => return Err(AccessError::Timeout("Sign-in timed out: the browser did not come back in time. Try again.".into())),
                r = self.listener.accept() => r.map_err(|e| AccessError::Other(e.to_string()))?,
            };
            let target = match tokio::time::timeout(Duration::from_secs(5), read_target(&mut sock)).await {
                Ok(Some(t)) => t,
                _ => continue,
            };
            let Some(query) = target.strip_prefix("/callback").filter(|r| r.is_empty() || r.starts_with('?')) else {
                respond(&mut sock, 404, &page(false, "Not found.")).await;
                continue;
            };
            let params: Vec<(String, String)> = url::form_urlencoded::parse(query.trim_start_matches('?').as_bytes()).into_owned().collect();
            let get = |k: &str| params.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
            if let Some(err) = get("error") {
                let detail: String = get("error_description").unwrap_or(err).chars().filter(|c| !c.is_control()).take(300).collect();
                respond(&mut sock, 400, &page(false, "Sign-in failed. Return to Lord of the Rows for details.")).await;
                return Err(AccessError::Forbidden(format!("Sign-in failed: {detail}")));
            }
            if get("state") != Some(self.state.as_str()) {
                respond(&mut sock, 400, &page(false, "This sign-in response does not belong to the current attempt. Start again from Lord of the Rows.")).await;
                return Err(AccessError::Forbidden("Sign-in response did not match this attempt (state mismatch). Try again.".into()));
            }
            let Some(code) = get("code").filter(|c| !c.is_empty() && c.len() <= 2048) else {
                respond(&mut sock, 400, &page(false, "The sign-in response had no code. Start again from Lord of the Rows.")).await;
                return Err(AccessError::Forbidden("Sign-in response had no authorization code. Try again.".into()));
            };
            respond(&mut sock, 200, &page(true, "Signed in — you can return to Lord of the Rows.")).await;
            return Ok(code.to_string());
        }
    }
}

/// Code returned by the browser step, with what the token exchange needs.
pub struct Authorization {
    pub code: String,
    pub verifier: String,
    pub redirect_uri: String,
}

/// Runs the browser step: bind, open `start_url(&loopback)`, wait for the redirect.
/// The listener is closed before this returns.
pub async fn authorize(ctx: &SignInContext<'_>, start_url: impl FnOnce(&Loopback) -> String) -> AccessResult<Authorization> {
    let lb = Loopback::bind().await?;
    (ctx.open_browser)(&start_url(&lb))?;
    let code = lb.wait_for_code(&ctx.cancel, ctx.timeout).await?;
    Ok(Authorization { code, verifier: lb.pkce.verifier.clone(), redirect_uri: lb.redirect_uri() })
}

/// Reads the request line and returns the request target of a `GET`.
async fn read_target(s: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    while !buf.windows(2).any(|w| w == b"\r\n") {
        let n = s.read(&mut chunk).await.ok()?;
        if n == 0 || buf.len() > 16 * 1024 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let line = String::from_utf8_lossy(&buf).lines().next()?.to_string();
    let mut parts = line.split(' ');
    (parts.next()? == "GET").then_some(())?;
    parts.next().map(String::from)
}

async fn respond(s: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\ncache-control: no-store\r\ncontent-security-policy: default-src 'none'; style-src 'unsafe-inline'\r\nreferrer-policy: no-referrer\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = s.write_all(head.as_bytes()).await;
    let _ = s.write_all(body.as_bytes()).await;
    let _ = s.shutdown().await;
}

fn page(ok: bool, message: &str) -> String {
    let (mark, tint) = if ok { ("&#10003;", "#16a34a") } else { ("!", "#dc2626") };
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lord of the Rows</title><style>
:root{{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1f2328;--muted:#656d76;--border:#d0d7de}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0d1117;--card:#161b22;--fg:#e6edf3;--muted:#8d96a0;--border:#30363d}}}}
body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}}
main{{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:32px 40px;max-width:420px;text-align:center;box-shadow:0 10px 40px rgb(0 0 0/.08)}}
.mark{{width:44px;height:44px;border-radius:50%;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#fff;background:{tint}}}
h1{{font-size:18px;margin:0 0 6px}}p{{margin:0;color:var(--muted)}}
</style></head><body><main><div class="mark">{mark}</div><h1>Lord of the Rows</h1><p>{message}</p></main></body></html>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_and_pkce() {
        assert_eq!(b64url(b""), "");
        assert_eq!(b64url(b"f"), "Zg");
        assert_eq!(b64url(b"fo"), "Zm8");
        assert_eq!(b64url(b"foo"), "Zm9v");
        assert_eq!(b64url(&[0xfb, 0xff]), "-_8");
        // RFC 7636 appendix B.
        assert_eq!(challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let p = Pkce::new();
        assert_eq!(p.verifier.len(), 43);
        assert_ne!(p.verifier, Pkce::new().verifier);
    }

    fn ctx<'a>(open: &'a BrowserFn, cancel: CancellationToken, timeout: Duration) -> SignInContext<'a> {
        SignInContext { device_name: "test", open_browser: open, cancel, timeout }
    }
    type BrowserFn = crate::BrowserOpener;

    /// Plays the browser: requests the URL it was given, with `state` replaced if asked.
    fn browser(forge_state: bool) -> Box<BrowserFn> {
        Box::new(move |url: &str| {
            let u = url::Url::parse(url).unwrap();
            let get = |k: &str| u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.to_string()).unwrap();
            assert_eq!(get("code_challenge_method"), "S256");
            let state = if forge_state { "forged".to_string() } else { get("state") };
            let cb = format!("{}?code=abc123&state={state}", get("redirect_uri"));
            tokio::spawn(async move {
                let _ = reqwest::get(cb).await;
            });
            Ok(())
        })
    }

    fn start(lb: &Loopback) -> String {
        let mut u = url::Url::parse("http://127.0.0.1:1/start").unwrap();
        lb.append_params(&mut u);
        u.into()
    }

    #[tokio::test]
    async fn authorize_returns_code_and_matching_verifier() {
        let open = browser(false);
        let mut challenge = String::new();
        let a = authorize(&ctx(&*open, CancellationToken::new(), Duration::from_secs(10)), |lb| {
            challenge = lb.pkce.challenge.clone();
            start(lb)
        })
        .await
        .unwrap();
        assert_eq!(a.code, "abc123");
        assert_eq!(challenge_for(&a.verifier), challenge);
        assert!(a.redirect_uri.starts_with("http://127.0.0.1:") && a.redirect_uri.ends_with("/callback"));
    }

    #[tokio::test]
    async fn state_mismatch_is_refused() {
        let open = browser(true);
        let Err(e) = authorize(&ctx(&*open, CancellationToken::new(), Duration::from_secs(10)), start).await else { panic!("forged state accepted") };
        assert!(e.to_string().contains("state mismatch"), "{e}");
    }

    #[tokio::test]
    async fn cancel_and_timeout() {
        let cancel = CancellationToken::new();
        let c2 = cancel.clone();
        let open: Box<BrowserFn> = Box::new(move |_| {
            c2.cancel();
            Ok(())
        });
        assert_eq!(authorize(&ctx(&*open, cancel, Duration::from_secs(10)), start).await.err(), Some(AccessError::Cancelled));
        let idle: Box<BrowserFn> = Box::new(|_| Ok(()));
        assert!(matches!(authorize(&ctx(&*idle, CancellationToken::new(), Duration::from_millis(100)), start).await, Err(AccessError::Timeout(_))));
    }

    #[tokio::test]
    async fn listener_ignores_other_paths_and_reports_idp_errors() {
        let lb = Loopback::bind().await.unwrap();
        let base = lb.redirect_uri().trim_end_matches("/callback").to_string();
        let state = lb.state.clone();
        let t = tokio::spawn(async move {
            let r = reqwest::get(format!("{base}/favicon.ico")).await.unwrap();
            assert_eq!(r.status(), 404);
            let r = reqwest::get(format!("{base}/callback?error=access_denied&error_description=User+cancelled&state={state}")).await.unwrap();
            assert_eq!(r.status(), 400);
        });
        let e = lb.wait_for_code(&CancellationToken::new(), Duration::from_secs(10)).await.unwrap_err();
        assert!(e.to_string().contains("User cancelled"), "{e}");
        t.await.unwrap();
    }

    #[tokio::test]
    async fn success_page_is_served() {
        let lb = Loopback::bind().await.unwrap();
        let url = format!("{}?code=c&state={}", lb.redirect_uri(), lb.state);
        let t = tokio::spawn(async move { reqwest::get(url).await.unwrap().text().await.unwrap() });
        assert_eq!(lb.wait_for_code(&CancellationToken::new(), Duration::from_secs(10)).await.unwrap(), "c");
        assert!(t.await.unwrap().contains("you can return to Lord of the Rows"));
    }
}
