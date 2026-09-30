//! `browser.open` from the runtime (§10.4): the identity provider's sign-in page opens in the
//! system browser, never in the webview (RFC 8252). The runtime is trusted, but the shell still
//! opens only web pages: https, and plain http on the loopback address in development builds,
//! where the tests' local issuer runs. The URL carries the PKCE state, so only its host is logged.

/// The URL's host if the shell should open it.
pub fn sign_in_host(url: &str, dev: bool) -> Option<String> {
    if url.len() > 4096 || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let (scheme, rest) = url.split_once("://")?;
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    if authority.is_empty() || authority.contains('@') || authority.contains('\\') {
        return None;
    }
    let host = match authority.strip_prefix('[') {
        Some(v6) => format!("[{}]", v6.split_once(']')?.0),
        None => authority.split(':').next()?.to_string(),
    }
    .to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    let loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]");
    match scheme.to_ascii_lowercase().as_str() {
        "https" => Some(host),
        "http" if dev && loopback => Some(host),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_opens_and_logs_only_the_host() {
        let u = "https://auth.example.com/oauth2/authorize?client_id=c&code_challenge=x&state=s";
        assert_eq!(sign_in_host(u, false).as_deref(), Some("auth.example.com"));
        assert_eq!(sign_in_host("HTTPS://Auth.Example.com:8443", false).as_deref(), Some("auth.example.com"));
    }

    #[test]
    fn loopback_http_only_in_development() {
        for u in ["http://127.0.0.1:5173/authorize?x=1", "http://localhost:9/a", "http://[::1]:80/"] {
            assert!(sign_in_host(u, true).is_some(), "{u}");
            assert_eq!(sign_in_host(u, false), None, "{u}");
        }
        assert_eq!(sign_in_host("http://auth.example.com/", true), None);
        assert_eq!(sign_in_host("http://127.0.0.1.evil.com/", true), None);
    }

    #[test]
    fn nothing_else_opens() {
        for u in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost",
            "mailto:a@b.c",
            "https://user@evil.com/",
            "https://a b",
            "https://a\nb",
            "https:///path",
            "https://",
            "-R",
            "x-apple.systempreferences:com.apple.preference",
        ] {
            assert_eq!(sign_in_host(u, true), None, "{u}");
        }
        assert_eq!(sign_in_host(&format!("https://a.com/{}", "x".repeat(5000)), false), None);
    }
}
