use std::fs::File;
use std::io::Read;

/// A fresh 256-bit launch token, 64 lowercase hex digits (§5.2). It goes to `homerund` on stdin
/// line 1 only, never argv or env, and the webview never sees it.
pub fn launch_token() -> std::io::Result<String> {
    let mut b = [0u8; 32];
    File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

#[cfg(test)]
mod tests {
    #[test]
    fn is_64_hex_and_fresh() {
        let a = super::launch_token().unwrap();
        let b = super::launch_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b);
    }
}
