mod config;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::load_client_config,
            config::save_client_config,
            workspace::open_workspace,
            workspace::open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
