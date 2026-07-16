// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod proxy;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(proxy::ApiConfig {
            base_url: String::from("https://jiangnan.88933.vip/music/"),
        })
        .invoke_handler(tauri::generate_handler![proxy::api_request, proxy::fetch_audio_by_track])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
