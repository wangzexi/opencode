use tauri_plugin_window_state::StateFlags;

pub const SETTINGS_STORE: &str = "opencode.settings.dat";
pub const DEFAULT_SERVER_URL_KEY: &str = "defaultServerUrl";
pub const WSL_ENABLED_KEY: &str = "wslEnabled";
pub const INBOUND_ENABLED_KEY: &str = "inboundEnabled";
pub const INBOUND_USERNAME_KEY: &str = "inboundUsername";
pub const INBOUND_PASSWORD_KEY: &str = "inboundPassword";
pub const INBOUND_PORT_KEY: &str = "inboundPort";
pub const UPDATER_ENABLED: bool = option_env!("TAURI_SIGNING_PRIVATE_KEY").is_some();

pub fn window_state_flags() -> StateFlags {
    StateFlags::all() - StateFlags::DECORATIONS - StateFlags::VISIBLE
}
