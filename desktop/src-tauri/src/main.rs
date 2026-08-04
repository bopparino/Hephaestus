// Hephaestus desktop — the glass, not the engine. This window is a webview
// onto the local daemon (hephd) at 127.0.0.1:7715, authenticated by the
// same token file the CLI uses, passed in the URL fragment exactly like
// `heph ui` does. The engine installs separately (install.sh); if the
// daemon isn't running we make one best-effort attempt to start it.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{process::Command, thread, time::Duration};
use tauri::{WebviewUrl, WebviewWindowBuilder};

const DAEMON_URL: &str = "http://127.0.0.1:7715";

fn read_token() -> String {
    dirs::home_dir()
        .map(|home| home.join(".hephaestus").join("daemon.token"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|token| token.trim().to_string())
        .unwrap_or_default()
}

fn daemon_up() -> bool {
    // A plain TCP connect is enough of a health probe for "is hephd there".
    std::net::TcpStream::connect_timeout(
        &"127.0.0.1:7715".parse().unwrap(),
        Duration::from_millis(400),
    )
    .is_ok()
}

fn main() {
    if !daemon_up() {
        // Best effort: the engine may be installed but idle. `heph start`
        // daemonizes and returns; failure here just means the window shows
        // the connection error and the user runs the installer.
        let _ = Command::new("heph").arg("start").spawn();
        for _ in 0..10 {
            if daemon_up() {
                break;
            }
            thread::sleep(Duration::from_millis(300));
        }
    }

    tauri::Builder::default()
        .setup(|app| {
            let url = format!("{DAEMON_URL}/#{}", read_token());
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("Hephaestus")
                .inner_size(1512.0, 944.0)
                .min_inner_size(1100.0, 700.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("hephaestus window failed");
}
