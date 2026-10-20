//! Central runtime configuration.
//!
//! Every environment variable the server understands is read here (file storage
//! keeps its detailed R2 validation in `storage.rs`). `Config::load` validates
//! the values once at startup and `Config::summary` prints the effective
//! configuration without secrets.
use sqlx::postgres::PgConnectOptions;
use std::net::{IpAddr, SocketAddr};

pub const DEFAULT_BIND: &str = "127.0.0.1:3210";
pub const DEFAULT_MAX_BACKUP_BYTES: u64 = 512 * 1024 * 1024;
const TAURI_ORIGINS: [&str; 3] = [
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];
/// Placeholder values shipped in `.env.example`; refusing them prevents a
/// deployment from running with a password published in the repository.
const PLACEHOLDERS: [&str; 3] = [
    "change_this_password",
    "replace_with_your_existing_password",
    "change_me",
];

fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}
fn list(name: &str) -> Vec<String> {
    var(name)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Runtime settings that do not involve the database connection.
/// Which web content the server publishes besides `/api`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WebUi {
    /// Serve the full SPA from `FRONTEND_DIR` (default, previous behavior).
    #[default]
    Full,
    /// Serve only a static intro page at `/`; the vault is used via the desktop client.
    Landing,
    /// No web content at all; only `/api`.
    Off,
}
impl WebUi {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "full" => Ok(Self::Full),
            "landing" => Ok(Self::Landing),
            "off" => Ok(Self::Off),
            other => Err(format!(
                "WEB_UI 只能是 full、landing 或 off，当前为：{other}"
            )),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Landing => "landing",
            Self::Off => "off",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Settings {
    pub web_ui: WebUi,
    pub landing_download_url: Option<String>,
    pub download_base_url: String,
    pub bind_addr: SocketAddr,
    pub frontend_dir: String,
    pub allowed_origins: Vec<String>,
    pub allowed_private_hosts: Vec<String>,
    pub github_token: Option<String>,
    pub github_api_base: String,
    pub trusted_proxies: Vec<IpAddr>,
    pub max_backup_bytes: u64,
    pub setup_token: Option<String>,
    pub file_storage: String,
}
impl Default for Settings {
    fn default() -> Self {
        let bind_addr: SocketAddr = DEFAULT_BIND.parse().unwrap();
        Self {
            web_ui: WebUi::Full,
            landing_download_url: None,
            download_base_url: crate::download::DEFAULT_BASE.into(),
            allowed_origins: default_origins(bind_addr.port(), None),
            bind_addr,
            frontend_dir: "dist".into(),
            allowed_private_hosts: vec![],
            github_token: None,
            github_api_base: "https://api.github.com".into(),
            trusted_proxies: vec![],
            max_backup_bytes: DEFAULT_MAX_BACKUP_BYTES,
            setup_token: None,
            file_storage: "local".into(),
        }
    }
}

/// Browser origins allowed by default: the server's own address on both
/// loopback names, the published host port (Compose), the Vite dev server,
/// the optional PUBLIC_URL and the Tauri desktop shells.
pub fn default_origins(port: u16, public_port: Option<u16>) -> Vec<String> {
    let mut ports = vec![port];
    if let Some(p) = public_port.filter(|p| *p != port) {
        ports.push(p);
    }
    ports.push(5173);
    let mut origins: Vec<String> = ports
        .iter()
        .flat_map(|p| {
            [
                format!("http://localhost:{p}"),
                format!("http://127.0.0.1:{p}"),
            ]
        })
        .collect();
    if let Some(url) = var("PUBLIC_URL") {
        if let Ok(url) = url::Url::parse(&url) {
            origins.push(url.origin().ascii_serialization());
        }
    }
    origins.extend(TAURI_ORIGINS.iter().map(|s| s.to_string()));
    origins
}

impl Settings {
    pub fn from_env() -> Result<Self, String> {
        let bind_addr: SocketAddr = var("BIND_ADDR")
            .unwrap_or_else(|| DEFAULT_BIND.into())
            .parse()
            .map_err(|_| "BIND_ADDR 必须是 IP:端口，例如 127.0.0.1:3210".to_string())?;
        let public_port = match var("INFOHUB_PORT") {
            Some(p) => Some(p.parse::<u16>().map_err(|_| "INFOHUB_PORT 必须是端口号")?),
            None => None,
        };
        let web_ui = WebUi::parse(&var("WEB_UI").unwrap_or_default())?;
        let download_base_url = match var("DOWNLOAD_BASE_URL") {
            Some(u) => {
                let ok = url::Url::parse(&u)
                    .map(|p| matches!(p.scheme(), "http" | "https"))
                    .unwrap_or(false);
                if !ok {
                    return Err("DOWNLOAD_BASE_URL 必须是完整的 http(s) 地址".into());
                }
                u
            }
            None => crate::download::DEFAULT_BASE.into(),
        };
        let landing_download_url = match var("LANDING_DOWNLOAD_URL") {
            Some(u) => {
                let parsed = url::Url::parse(&u)
                    .map_err(|_| "LANDING_DOWNLOAD_URL 必须是完整的 http(s) 地址".to_string())?;
                if !matches!(parsed.scheme(), "http" | "https") {
                    return Err("LANDING_DOWNLOAD_URL 必须以 http:// 或 https:// 开头".into());
                }
                Some(parsed.to_string())
            }
            None => None,
        };
        let allowed_origins = match var("ALLOWED_ORIGINS") {
            Some(_) => list("ALLOWED_ORIGINS"),
            // Without a web UI there is no browser origin to allow; only the
            // Tauri desktop WebView (which calls the API with fetch/CORS) remains.
            None if web_ui != WebUi::Full => TAURI_ORIGINS.iter().map(|s| s.to_string()).collect(),
            None => default_origins(bind_addr.port(), public_port),
        };
        for origin in &allowed_origins {
            if origin.parse::<axum::http::HeaderValue>().is_err() || !origin.contains("://") {
                return Err(format!("ALLOWED_ORIGINS 中的来源无效：{origin}"));
            }
        }
        let trusted_proxies = list("TRUSTED_PROXIES")
            .iter()
            .map(|s| {
                s.parse::<IpAddr>()
                    .map_err(|_| format!("TRUSTED_PROXIES 中的 IP 无效：{s}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let max_backup_bytes = match var("MAX_BACKUP_BYTES") {
            Some(v) => v
                .parse::<u64>()
                .map_err(|_| "MAX_BACKUP_BYTES 必须是字节数")?,
            None => DEFAULT_MAX_BACKUP_BYTES,
        };
        let setup_token = var("SETUP_TOKEN");
        if setup_token.as_ref().is_some_and(|t| t.len() < 16) {
            return Err("SETUP_TOKEN 至少 16 个字符".into());
        }
        let file_storage = var("FILE_STORAGE").unwrap_or_else(|| "local".into());
        if !["local", "r2"].contains(&file_storage.as_str()) {
            return Err("FILE_STORAGE 只能是 local 或 r2".into());
        }
        Ok(Self {
            web_ui,
            landing_download_url,
            download_base_url,
            bind_addr,
            frontend_dir: var("FRONTEND_DIR").unwrap_or_else(|| "dist".into()),
            allowed_origins,
            allowed_private_hosts: list("ALLOWED_PRIVATE_HOSTS"),
            github_token: var("GITHUB_TOKEN"),
            github_api_base: var("GITHUB_API_BASE")
                .unwrap_or_else(|| "https://api.github.com".into()),
            trusted_proxies,
            max_backup_bytes,
            setup_token,
            file_storage,
        })
    }
}

pub struct Config {
    pub settings: Settings,
    pub database: PgConnectOptions,
    database_summary: String,
}

fn is_placeholder(password: &str) -> bool {
    PLACEHOLDERS
        .iter()
        .any(|p| password.eq_ignore_ascii_case(p))
}

impl Config {
    pub fn load() -> Result<Self, String> {
        let settings = Settings::from_env()?;
        let (database, password, source) = if let Some(url) = var("DATABASE_URL") {
            let parsed = url::Url::parse(&url)
                .map_err(|_| "DATABASE_URL 不是有效的 postgres:// 地址".to_string())?;
            if !matches!(parsed.scheme(), "postgres" | "postgresql") {
                return Err("DATABASE_URL 必须以 postgres:// 开头".into());
            }
            let password = percent_decode(parsed.password().unwrap_or_default());
            let options = url
                .parse::<PgConnectOptions>()
                .map_err(|e| format!("DATABASE_URL 无法解析：{e}"))?;
            (options, password, "DATABASE_URL")
        } else if let Some(host) = var("PGHOST") {
            // Deprecated fallback kept for existing deployments. PGSSLMODE and
            // PGSSLROOTCERT are still honoured by sqlx from the environment.
            let port = var("PGPORT")
                .unwrap_or_else(|| "5432".into())
                .parse::<u16>()
                .map_err(|_| "PGPORT 必须是端口号")?;
            let user = var("PGUSER").ok_or("使用 PGHOST 时还需要 PGUSER")?;
            let password =
                std::env::var("PGPASSWORD").map_err(|_| "使用 PGHOST 时还需要 PGPASSWORD")?;
            let db = var("PGDATABASE").ok_or("使用 PGHOST 时还需要 PGDATABASE")?;
            let options = PgConnectOptions::new()
                .host(&host)
                .port(port)
                .username(&user)
                .password(&password)
                .database(&db);
            (
                options,
                password,
                "PGHOST/PGUSER/...（已弃用，请改用 DATABASE_URL）",
            )
        } else {
            return Err("请设置 DATABASE_URL（参见 .env.example）".into());
        };
        if is_placeholder(&password) {
            return Err("数据库密码仍是示例占位值，请在 .env 中换成真实的随机密码".into());
        }
        let database_summary = format!(
            "{} → {}:{}/{}（用户 {}）",
            source,
            database.get_host(),
            database.get_port(),
            database.get_database().unwrap_or("?"),
            database.get_username(),
        );
        Ok(Self {
            settings,
            database,
            database_summary,
        })
    }

    /// Human-readable configuration summary. Never includes secrets.
    pub fn summary(&self) -> String {
        let s = &self.settings;
        format!(
            "数据库: {}\n监听: {}\n网页界面: {}\n前端目录: {}\n允许来源: {}\n内网白名单: {}\n可信代理: {}\n文件存储: {}\n备份上限: {} MiB\nGitHub Token: {}\n初始化令牌: {}",
            self.database_summary,
            s.bind_addr,
            match s.web_ui {
                WebUi::Landing => format!("landing（下载地址：{}）", s.landing_download_url.as_deref().unwrap_or("未设置")),
                other => other.as_str().to_string(),
            },
            if s.web_ui == WebUi::Full { s.frontend_dir.as_str() } else { "（未使用）" },
            if s.allowed_origins.is_empty() { "（无）".to_string() } else { s.allowed_origins.join(", ") },
            if s.allowed_private_hosts.is_empty() { "（无）".into() } else { s.allowed_private_hosts.join(", ") },
            if s.trusted_proxies.is_empty() { "（无，按连接地址限流）".into() } else { s.trusted_proxies.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(", ") },
            s.file_storage,
            s.max_backup_bytes / 1024 / 1024,
            if s.github_token.is_some() { "已设置" } else { "未设置" },
            if s.setup_token.is_some() { "来自 SETUP_TOKEN" } else { "未初始化时自动生成" },
        )
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn placeholder_passwords_are_detected() {
        assert!(is_placeholder("change_this_password"));
        assert!(is_placeholder("replace_with_your_existing_password"));
        assert!(!is_placeholder("a-real-random-secret"));
    }
    #[test]
    fn percent_encoded_passwords_decode() {
        assert_eq!(
            percent_decode("change%5Fthis_password"),
            "change_this_password"
        );
        assert_eq!(percent_decode("p%40ss"), "p@ss");
        assert_eq!(percent_decode("plain"), "plain");
    }
    #[test]
    fn web_ui_values_are_validated() {
        assert_eq!(WebUi::parse("").unwrap(), WebUi::Full);
        assert_eq!(WebUi::parse("FULL").unwrap(), WebUi::Full);
        assert_eq!(WebUi::parse("landing").unwrap(), WebUi::Landing);
        assert_eq!(WebUi::parse(" off ").unwrap(), WebUi::Off);
        assert!(WebUi::parse("spa").is_err());
    }
    #[test]
    fn default_origins_follow_the_ports() {
        let o = default_origins(3210, Some(8080));
        assert!(o.contains(&"http://127.0.0.1:3210".to_string()));
        assert!(o.contains(&"http://localhost:8080".to_string()));
        assert!(o.contains(&"http://localhost:5173".to_string()));
        assert!(o.contains(&"tauri://localhost".to_string()));
    }
}
