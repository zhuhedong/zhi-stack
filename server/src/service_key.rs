//! Server-held key for secrets that unattended work needs while nobody is
//! logged in (scheduled-backup keys, notification credentials). It never lives
//! in the database: it comes from INFOHUB_SERVICE_KEY (64 hex chars) or a
//! 0600 key file, created on first use, next to the local file storage
//! (SERVICE_KEY_FILE overrides the path).
use crate::error::{AppError, Result};
use rand::RngCore;
use tokio::sync::OnceCell;
use zeroize::Zeroizing;

static KEY: OnceCell<Zeroizing<[u8; 32]>> = OnceCell::const_new();

fn path() -> std::path::PathBuf {
    if let Ok(file) = std::env::var("SERVICE_KEY_FILE") {
        return file.into();
    }
    let root = std::env::var("LOCAL_STORAGE_PATH").unwrap_or_else(|_| ".local/files".into());
    std::path::Path::new(&root).join(".infohub-service-key")
}
fn parse(hex_key: &str) -> Result<Zeroizing<[u8; 32]>> {
    let bytes = Zeroizing::new(hex::decode(hex_key.trim()).map_err(|_| invalid())?);
    let mut key = Zeroizing::new([0u8; 32]);
    if bytes.len() != 32 {
        return Err(invalid());
    }
    key.copy_from_slice(&bytes);
    Ok(key)
}
fn invalid() -> AppError {
    AppError::bad("服务密钥格式无效：INFOHUB_SERVICE_KEY 或密钥文件需为 64 位十六进制")
}
async fn load() -> Result<Zeroizing<[u8; 32]>> {
    if let Ok(value) = std::env::var("INFOHUB_SERVICE_KEY") {
        return parse(&value);
    }
    let path = path();
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => return parse(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(AppError::bad("无法读取服务密钥文件")),
    }
    let mut key = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(key.as_mut());
    let encoded = Zeroizing::new(hex::encode(key.as_ref()));
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| AppError::bad("无法创建服务密钥目录"))?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    match options.open(&path) {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(encoded.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|_| AppError::bad("无法写入服务密钥文件"))?;
            Ok(key)
        }
        // Another process created it first.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => parse(
            &tokio::fs::read_to_string(&path)
                .await
                .map_err(|_| invalid())?,
        ),
        Err(_) => Err(AppError::bad("无法写入服务密钥文件")),
    }
}
pub async fn get() -> Result<&'static [u8; 32]> {
    KEY.get_or_try_init(load).await.map(|k| &**k)
}
pub async fn seal(plain: &[u8], context: &str) -> Result<Vec<u8>> {
    crate::crypto::encrypt(get().await?, plain, context)
}
pub async fn open(sealed: &[u8], context: &str) -> Result<Zeroizing<Vec<u8>>> {
    crate::crypto::decrypt(get().await?, sealed, context)
        .map_err(|_| AppError::bad("服务密钥已变化，请重新配置（重新输入主密码或通知密钥）"))
}
