use crate::error::{AppError, Result};
use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use zeroize::Zeroizing;

pub type VaultKey = Zeroizing<[u8; 32]>;

pub async fn derive(password: String, salt: Vec<u8>) -> Result<VaultKey> {
    tokio::task::spawn_blocking(move || {
        let password = Zeroizing::new(password);
        let mut key = Zeroizing::new([0u8; 32]);
        Argon2::default()
            .hash_password_into(password.as_bytes(), &salt, key.as_mut())
            .map_err(|_| AppError::bad("无法派生加密密钥"))?;
        Ok(key)
    })
    .await
    .map_err(|_| AppError::bad("密钥计算失败"))?
}

pub fn encrypt(key: &[u8; 32], plaintext: &[u8], context: &str) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| AppError::bad("无效密钥"))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| AppError::bad("加密失败"))?;
    Ok([nonce.to_vec(), ciphertext].concat())
}

pub fn decrypt(key: &[u8; 32], value: &[u8], context: &str) -> Result<Zeroizing<Vec<u8>>> {
    if value.len() < 28 {
        return Err(AppError::bad("加密数据损坏"));
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| AppError::bad("无效密钥"))?;
    cipher
        .decrypt(
            Nonce::from_slice(&value[..12]),
            Payload {
                msg: &value[12..],
                aad: context.as_bytes(),
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| AppError::bad("主密码错误或加密数据损坏"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encryption_authenticates_record_and_rejects_tampering() {
        let key = [7; 32];
        let mut sealed = encrypt(&key, b"private-password", "item:a").unwrap();
        assert_eq!(
            &**decrypt(&key, &sealed, "item:a").unwrap(),
            b"private-password"
        );
        assert!(decrypt(&key, &sealed, "item:b").is_err());
        assert!(decrypt(&[8; 32], &sealed, "item:a").is_err());
        sealed[20] ^= 1;
        assert!(decrypt(&key, &sealed, "item:a").is_err());
        assert!(decrypt(&key, &[0; 4], "item:a").is_err());
    }
}
