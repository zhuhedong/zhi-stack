use crate::error::{AppError, Result};
use axum::http::StatusCode;
use object_store::{
    aws::AmazonS3Builder, local::LocalFileSystem, path::Path, ClientOptions, ObjectStore, PutMode,
    RetryConfig,
};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc, time::Duration};
use uuid::Uuid;

// 10 MiB plus the AES-GCM nonce and authentication tag.
const MAX_STORED_SIZE: u64 = 10 * 1024 * 1024 + 28;

#[derive(Clone)]
pub struct FileStorage {
    store: Arc<dyn ObjectStore>,
    pub id: String,
    pub kind: &'static str,
    local_root: Option<Arc<PathBuf>>,
}

fn unavailable(operation: &str) -> AppError {
    // SDK error chains can contain signed requests and credentials. Do not log them.
    tracing::error!(operation, "File storage operation failed");
    AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "文件存储不可用或文件校验失败，请检查存储配置、文件和服务端日志".into(),
    )
}

pub fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn object_path(key: &str) -> Result<Path> {
    let valid = key.split_once('/').is_some_and(|(kind, id)| {
        matches!(kind, "attachments" | "media" | "checks")
            && Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id)
    });
    if !valid {
        return Err(unavailable("invalid object key"));
    }
    Ok(Path::from(key))
}

impl FileStorage {
    pub async fn from_env() -> Result<Self> {
        let backend = std::env::var("FILE_STORAGE").unwrap_or_else(|_| "local".into());
        match backend.as_str() {
            "local" => {
                let root =
                    std::env::var("LOCAL_STORAGE_PATH").unwrap_or_else(|_| ".local/files".into());
                let storage = Self::local(std::path::Path::new(&root)).await?;
                let frontend = std::env::var("FRONTEND_DIR").unwrap_or_else(|_| "dist".into());
                if let Ok(public) = tokio::fs::canonicalize(frontend).await {
                    if storage
                        .local_root
                        .as_ref()
                        .is_some_and(|root| root.starts_with(public))
                    {
                        return Err(AppError::bad(
                            "文件存储目录不能位于公开的 FRONTEND_DIR 中，请选择独立目录",
                        ));
                    }
                }
                Ok(storage)
            }
            "r2" => {
                let required = |name| {
                    std::env::var(name)
                        .ok()
                        .filter(|s| !s.trim().is_empty())
                        .ok_or_else(|| AppError::bad(format!("R2 存储缺少配置：{name}")))
                };
                let endpoint = required("R2_ENDPOINT")?;
                let endpoint = url::Url::parse(&endpoint)
                    .map_err(|_| AppError::bad("R2_ENDPOINT 必须是有效的 HTTPS 地址"))?;
                let allow_http = std::env::var("R2_ALLOW_HTTP").is_ok_and(|v| v == "true");
                if !(endpoint.scheme() == "https" || (allow_http && endpoint.scheme() == "http"))
                    || endpoint.host_str().is_none()
                    || !endpoint.username().is_empty()
                    || endpoint.password().is_some()
                    || endpoint.query().is_some()
                    || endpoint.fragment().is_some()
                    || endpoint.path() != "/"
                {
                    return Err(AppError::bad(
                        "R2_ENDPOINT 必须是账户的 HTTPS S3 端点，不能带 Bucket 路径或密钥",
                    ));
                }
                let endpoint = endpoint.as_str().trim_end_matches('/');
                let bucket = required("R2_BUCKET")?;
                if bucket.len() < 3
                    || bucket.len() > 63
                    || !bucket
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                    || bucket.starts_with('-')
                    || bucket.ends_with('-')
                {
                    return Err(AppError::bad("R2_BUCKET 格式无效"));
                }
                let store = AmazonS3Builder::new()
                    .with_endpoint(endpoint)
                    .with_region("auto")
                    .with_bucket_name(&bucket)
                    .with_access_key_id(required("R2_ACCESS_KEY_ID")?)
                    .with_secret_access_key(required("R2_SECRET_ACCESS_KEY")?)
                    .with_virtual_hosted_style_request(false)
                    .with_client_options(ClientOptions::new().with_timeout(Duration::from_secs(30)))
                    .with_allow_http(allow_http)
                    .with_retry(RetryConfig {
                        max_retries: 2,
                        retry_timeout: Duration::from_secs(45),
                        ..Default::default()
                    })
                    .build()
                    .map_err(|_| unavailable("configure R2"))?;
                Ok(Self {
                    store: Arc::new(store),
                    id: format!("r2:{}", digest(format!("{endpoint}/{bucket}").as_bytes())),
                    kind: "r2",
                    local_root: None,
                })
            }
            _ => Err(AppError::bad("FILE_STORAGE 只支持 local 或 r2")),
        }
    }

    pub async fn local(root: &std::path::Path) -> Result<Self> {
        tokio::fs::create_dir_all(root)
            .await
            .map_err(|_| unavailable("create storage directory"))?;
        let root = tokio::fs::canonicalize(root)
            .await
            .map_err(|_| unavailable("resolve storage directory"))?;
        let store = LocalFileSystem::new_with_prefix(&root)
            .map_err(|_| unavailable("configure local storage"))?;
        // The marker travels with backups. Equal paths on different disks are
        // different stores, while relocating a complete directory keeps its ID.
        let marker = Path::from(".infohub-storage-id");
        let created = match store
            .put_opts(
                &marker,
                Uuid::new_v4().to_string().into_bytes().into(),
                PutMode::Create.into(),
            )
            .await
        {
            Ok(_) => true,
            Err(object_store::Error::AlreadyExists { .. }) => false,
            Err(_) => return Err(unavailable("create storage identity")),
        };
        let identity = store
            .get(&marker)
            .await
            .map_err(|_| unavailable("read storage identity"))?;
        if identity.meta.size != 36 {
            return Err(unavailable("invalid storage identity"));
        }
        let identity = identity
            .bytes()
            .await
            .map_err(|_| unavailable("read storage identity"))?;
        let identity = std::str::from_utf8(&identity)
            .ok()
            .and_then(|s| Uuid::parse_str(s).ok())
            .ok_or_else(|| unavailable("invalid storage identity"))?;
        let storage = Self {
            store: Arc::new(store),
            id: format!("local:{identity}"),
            kind: "local",
            local_root: Some(Arc::new(root)),
        };
        if created {
            storage.sync_local(".infohub-storage-id").await?;
        }
        Ok(storage)
    }

    pub fn is_legacy_local_id(&self, id: &str) -> bool {
        self.kind == "local"
            && id
                .strip_prefix("local:")
                .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit()))
    }

    async fn sync_local(&self, key: &str) -> Result<()> {
        if let Some(root) = &self.local_root {
            let path = root.join(key);
            tokio::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .await
                .map_err(|_| unavailable("open file for durable write"))?
                .sync_all()
                .await
                .map_err(|_| unavailable("flush file to disk"))?;
            #[cfg(unix)]
            for directory in [path.parent().unwrap(), root.as_path()] {
                tokio::fs::File::open(directory)
                    .await
                    .map_err(|_| unavailable("open storage directory"))?
                    .sync_all()
                    .await
                    .map_err(|_| unavailable("flush directory to disk"))?;
            }
        }
        Ok(())
    }

    pub async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        if bytes.len() as u64 > MAX_STORED_SIZE {
            return Err(unavailable("file exceeds size limit"));
        }
        self.store
            .put(&object_path(key)?, bytes.into())
            .await
            .map_err(|_| unavailable("write file"))?;
        self.sync_local(key).await
    }

    pub async fn read(&self, key: &str, size: i64, hash: &str) -> Result<Vec<u8>> {
        let result = self
            .store
            .get(&object_path(key)?)
            .await
            .map_err(|_| unavailable("read file"))?;
        if size < 0 || result.meta.size > MAX_STORED_SIZE || result.meta.size != size as u64 {
            return Err(unavailable("verify file size"));
        }
        let bytes = result
            .bytes()
            .await
            .map_err(|_| unavailable("read file body"))?;
        if bytes.len() as i64 != size || digest(&bytes) != hash {
            return Err(unavailable("verify file checksum"));
        }
        Ok(bytes.to_vec())
    }

    pub async fn delete(&self, key: &str) -> Result<()> {
        match self.store.delete(&object_path(key)?).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
            Err(_) => return Err(unavailable("delete file")),
        }
        // object_store's local atomic writes use <key>#<number> staging files.
        // A process killed during PUT cannot remove them. Only expired,
        // unreferenced objects reach this cleanup path.
        if let Some(root) = &self.local_root {
            let path = root.join(key);
            let parent = path
                .parent()
                .ok_or_else(|| unavailable("invalid file parent"))?;
            match tokio::fs::read_dir(parent).await {
                Ok(mut entries) => {
                    let prefix = format!("{}#", path.file_name().unwrap().to_string_lossy());
                    while let Some(entry) = entries
                        .next_entry()
                        .await
                        .map_err(|_| unavailable("list abandoned staging files"))?
                    {
                        let name = entry.file_name();
                        if name
                            .to_string_lossy()
                            .strip_prefix(&prefix)
                            .is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
                        {
                            match tokio::fs::remove_file(entry.path()).await {
                                Ok(()) => {}
                                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                                Err(_) => return Err(unavailable("delete abandoned staging file")),
                            }
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(unavailable("list storage directory")),
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn memory() -> Self {
        Self {
            store: Arc::new(object_store::memory::InMemory::new()),
            id: "test".into(),
            kind: "memory",
            local_root: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn storage_rejects_traversal_and_detects_corruption() {
        let store = FileStorage::memory();
        for key in [
            "../secret",
            "attachments/../../secret",
            "/media/test",
            "media/not-a-uuid",
        ] {
            assert!(store.put(key, vec![]).await.is_err());
        }
        let key = format!("attachments/{}", Uuid::new_v4());
        let bytes = b"persistent bytes".to_vec();
        let hash = digest(&bytes);
        store.put(&key, bytes.clone()).await.unwrap();
        assert_eq!(
            store.read(&key, bytes.len() as i64, &hash).await.unwrap(),
            bytes
        );
        assert!(store.read(&key, 0, &hash).await.is_err());
        store.put(&key, vec![0; bytes.len()]).await.unwrap();
        assert!(store.read(&key, bytes.len() as i64, &hash).await.is_err());
        store.delete(&key).await.unwrap();
        store.delete(&key).await.unwrap();
        assert!(store.read(&key, bytes.len() as i64, &hash).await.is_err());
    }
}
