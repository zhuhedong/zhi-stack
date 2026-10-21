import { useRef, useState } from 'react';
import { QrCode, ShieldCheck } from 'lucide-react';
import { parseOtp, readQrImage } from '../lib/totp';

/** Add a TOTP secret (otpauth link, base32 or QR image) to a credential's encrypted fields. */
export function TotpEditor({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  let problem = '';
  if (value?.trim()) {
    try {
      parseOtp(value);
    } catch (e) {
      problem = e instanceof Error ? e.message : 'TOTP 密钥无效';
    }
  }
  return (
    <div className="totp-editor">
      <div className="inline-actions">
        {value === undefined && (
          <button type="button" onClick={() => onChange('')}>
            <ShieldCheck size={13} /> 添加两步验证 (TOTP)
          </button>
        )}
        <button type="button" onClick={() => file.current?.click()}>
          <QrCode size={13} /> 从二维码图片导入
        </button>
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          aria-label="二维码图片"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = '';
            if (!picked) return;
            setError('');
            void readQrImage(picked)
              .then(onChange)
              .catch((err) => setError(err instanceof Error ? err.message : '无法识别二维码'));
          }}
        />
      </div>
      {value !== undefined && (
        <p className="form-hint">
          在上方“两步验证 (TOTP)”中粘贴 otpauth:// 链接或 Base32 密钥；它与其他属性一起加密保存。
        </p>
      )}
      {(problem || error) && (
        <p className="error" role="alert">
          {problem || error}
        </p>
      )}
    </div>
  );
}
