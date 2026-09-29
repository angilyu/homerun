/// The webview may invoke exactly these commands (§5.2): with an app manifest each one needs an
/// explicit permission, granted in `capabilities/default.json`.
const COMMANDS: &[&str] =
    &["rpc_call", "rpc_attach", "key_status", "key_set", "key_clear", "runtime_status", "runtime_restart", "open_external", "reveal_logs", "app_info"];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS))).expect("tauri-build");
}
