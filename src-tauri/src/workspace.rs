use std::{
    path::{Path, PathBuf},
    process::Command,
};

pub fn openable_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    let stripped = if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        raw.into_owned()
    };
    PathBuf::from(stripped)
}

#[tauri::command]
pub fn open_external_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "链接格式无效")?;
    if !["http", "https", "mailto"].contains(&parsed.scheme()) {
        return Err("不支持该链接协议".into());
    }
    opener::open(parsed.as_str()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_workspace(action: &str, path: &str) -> Result<(), String> {
    let path = Path::new(path);
    if !path.is_absolute() || !path.is_dir() {
        return Err("工作区必须是已存在的绝对目录路径".into());
    }
    let path = openable_path(&path.canonicalize().map_err(|_| "无法访问工作区目录")?);
    match action {
        "folder" => opener::open(&path).map_err(|e| e.to_string()),
        "vscode" => {
            // A URI launches the registered editor without putting user data in a shell command.
            let display = path.to_string_lossy().replace('\\', "/");
            let encoded: String = display
                .bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric() || b"/-_.:".contains(&b) {
                        (b as char).to_string()
                    } else {
                        format!("%{b:02X}")
                    }
                })
                .collect();
            opener::open(format!("vscode://file/{encoded}")).map_err(|e| e.to_string())
        }
        "terminal" => {
            // This visible terminal is the user's explicit desktop action, not a background helper.
            #[cfg(target_os = "windows")]
            let mut command = Command::new("powershell.exe");
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                command
                    .args(["-NoLogo", "-NoExit"])
                    .creation_flags(0x00000010);
            }
            #[cfg(target_os = "macos")]
            let mut command = {
                let mut c = Command::new("open");
                c.args(["-a", "Terminal"]);
                c.arg(&path);
                c
            };
            #[cfg(all(unix, not(target_os = "macos")))]
            let mut command = Command::new("x-terminal-emulator");
            command
                .current_dir(&path)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("无法启动终端：{e}"))
        }
        _ => Err("未知工作区操作".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_non_directory_and_relative_workspace_paths() {
        assert!(open_workspace("terminal", "relative/path").is_err());
        assert!(open_workspace("vscode", "").is_err());
        assert!(open_workspace(
            "folder",
            &std::env::current_exe().unwrap().to_string_lossy()
        )
        .is_err());
    }
    #[test]
    fn rejects_unknown_actions_without_launching_a_process() {
        assert_eq!(
            open_workspace(
                "arbitrary",
                &std::env::current_dir().unwrap().to_string_lossy()
            )
            .unwrap_err(),
            "未知工作区操作"
        );
    }
    #[test]
    fn strips_windows_verbatim_and_unc_prefixes() {
        assert_eq!(
            openable_path(Path::new(r"\\?\C:\Users\me\proj")),
            PathBuf::from(r"C:\Users\me\proj")
        );
        assert_eq!(
            openable_path(Path::new(r"\\?\UNC\server\share\repo")),
            PathBuf::from(r"\\server\share\repo")
        );
        assert_eq!(
            openable_path(Path::new(r"D:\develop\repo")),
            PathBuf::from(r"D:\develop\repo")
        );
    }
    #[test]
    fn rejects_executable_external_protocols() {
        for url in [
            "javascript:alert(1)",
            "file:///C:/Windows",
            "data:text/html,unsafe",
            "bad-url",
        ] {
            assert!(open_external_url(url).is_err());
        }
    }
}
