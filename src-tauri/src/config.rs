use serde::Serialize;
use serde_json::{Map, Value};
use std::{fs, io::Write, path::Path};
use tauri::{AppHandle, Manager};
use url::Url;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    server_url: Option<String>,
    config_path: String,
    error: Option<String>,
}

fn normalize_server_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.len() > 4096 || value.contains('\\') || value.chars().any(char::is_control) {
        return Err("服务地址无效，请填写完整的 HTTP 或 HTTPS 地址".into());
    }
    let mut url = Url::parse(value).map_err(|_| "请输入完整的 HTTP 或 HTTPS 服务地址")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("服务地址只支持 HTTP 或 HTTPS，不能包含账号、密码、查询参数或片段".into());
    }
    let mut path = url.path().trim_end_matches('/').to_string();
    if !path.ends_with("/api") {
        path.push_str("/api");
    }
    url.set_path(&path);
    Ok(url.into())
}

fn read_server_url(path: &Path) -> Result<Option<String>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取本机配置文件，请检查文件权限后重试".into()),
    };
    let config: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "配置文件不是有效的 JSON，请重新填写服务地址并保存")?;
    if !config.is_object() {
        return Err("配置文件格式无效，请重新填写服务地址并保存".into());
    }
    match config.get("serverUrl") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.trim().is_empty() => Ok(None),
        Some(Value::String(value)) => normalize_server_url(value).map(Some),
        _ => Err("配置文件中的 serverUrl 必须是服务地址字符串".into()),
    }
}

fn write_server_url(path: &Path, value: &str) -> Result<String, String> {
    let normalized = normalize_server_url(value)?;
    let parent = path.parent().ok_or("无法确定本机配置目录")?;
    fs::create_dir_all(parent).map_err(|_| "无法创建本机配置目录，请检查文件权限")?;
    let mut config = match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Map<String, Value>>(&bytes).unwrap_or_default(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(_) => return Err("无法读取原配置文件，未修改服务地址，请检查文件权限".into()),
    };
    config.insert("serverUrl".into(), Value::String(normalized.clone()));
    let bytes = serde_json::to_vec_pretty(&config).map_err(|_| "无法编码服务配置")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "无法创建临时配置文件，请检查目录权限")?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "无法写入本机配置文件，请检查磁盘空间和权限")?;
    temporary
        .persist(path)
        .map_err(|_| "无法保存本机配置文件，原配置已保留，请检查文件权限")?;
    Ok(normalized)
}

#[tauri::command]
pub fn load_client_config(app: AppHandle) -> Result<ClientConfig, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "无法确定本机配置目录")?
        .join("config.json");
    let (server_url, error) = match read_server_url(&path) {
        Ok(value) => (value, None),
        Err(error) => (None, Some(error)),
    };
    Ok(ClientConfig {
        server_url,
        config_path: path.to_string_lossy().into(),
        error,
    })
}

#[tauri::command]
pub fn save_client_config(app: AppHandle, server_url: String) -> Result<ClientConfig, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "无法确定本机配置目录")?
        .join("config.json");
    let normalized = write_server_url(&path, &server_url)?;
    Ok(ClientConfig {
        server_url: Some(normalized),
        config_path: path.to_string_lossy().into(),
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_config_requires_an_explicit_address_and_saved_config_survives_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("client/config.json");
        assert_eq!(read_server_url(&path).unwrap(), None);
        assert_eq!(
            write_server_url(&path, " https://example.com/infohub/ ").unwrap(),
            "https://example.com/infohub/api"
        );
        assert_eq!(
            read_server_url(&path).unwrap().as_deref(),
            Some("https://example.com/infohub/api")
        );
        let saved: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(saved.as_object().unwrap().len(), 1);
    }

    #[test]
    fn replacement_is_valid_json_and_preserves_other_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(
            &path,
            r#"{"serverUrl":"https://old.example/api","theme":"system"}"#,
        )
        .unwrap();
        write_server_url(&path, "http://127.0.0.1:3210/api/").unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["serverUrl"], "http://127.0.0.1:3210/api");
        assert_eq!(saved["theme"], "system");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn invalid_addresses_leave_existing_config_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        write_server_url(&path, "https://original.example").unwrap();
        let original = fs::read(&path).unwrap();
        for value in [
            "",
            "localhost:3210",
            "file:///tmp/config",
            "https://user:secret@example.com",
            "https://example.com?token=secret",
            "https://example.com#fragment",
            "https://exam\nple.com",
            "https://example.com\\api",
        ] {
            assert!(write_server_url(&path, value).is_err(), "{value}");
            assert_eq!(fs::read(&path).unwrap(), original);
        }
    }

    #[test]
    fn malformed_config_is_reported_and_can_be_repaired_by_saving() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, "{invalid").unwrap();
        assert!(read_server_url(&path).unwrap_err().contains("JSON"));
        write_server_url(&path, "https://recovered.example").unwrap();
        assert_eq!(
            read_server_url(&path).unwrap().as_deref(),
            Some("https://recovered.example/api")
        );
    }

    #[test]
    fn an_unwritable_destination_preserves_existing_data() {
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("blocked");
        fs::write(&blocked, "existing data").unwrap();
        assert!(write_server_url(&blocked.join("config.json"), "https://example.com").is_err());
        assert_eq!(fs::read_to_string(blocked).unwrap(), "existing data");
    }
}
