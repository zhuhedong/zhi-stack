import { useEffect, useMemo, useState } from 'react';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { parseOtp, secondsLeft, totpCode } from '../lib/totp';

/** Live TOTP code with countdown. The secret stays in memory on this device. */
export function TotpField({ value, onCopy }: { value: string; onCopy: (code: string) => void }) {
  const params = useMemo(() => {
    try {
      return { ok: parseOtp(value) } as const;
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'TOTP 密钥无效' } as const;
    }
  }, [value]);
  const [code, setCode] = useState('');
  const [left, setLeft] = useState(30);
  const [showSecret, setShowSecret] = useState(false);
  useEffect(() => {
    if (!('ok' in params) || !params.ok) return;
    const otp = params.ok;
    let live = true;
    const tick = () => {
      setLeft(secondsLeft(otp.period));
      void totpCode(otp).then((next) => live && setCode(next));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [params]);
  if ('error' in params) return <p className="error">{params.error}</p>;
  const otp = params.ok;
  const grouped = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  return (
    <div className="totp-field">
      <div className="totp-code" aria-live="polite" aria-label="当前验证码">
        <span className="mono">{grouped || '······'}</span>
        <span
          className={'totp-ring' + (left <= 5 ? ' expiring' : '')}
          style={{ '--fill': `${(left / otp.period) * 100}%` } as React.CSSProperties}
          title={`${left} 秒后刷新`}
        >
          {left}
        </span>
        <button className="icon-button" aria-label="复制验证码" disabled={!code} onClick={() => onCopy(code)}>
          <Copy size={13} />
        </button>
        <button
          className="icon-button"
          aria-label={showSecret ? '隐藏 TOTP 密钥' : '显示 TOTP 密钥'}
          onClick={() => setShowSecret((v) => !v)}
        >
          {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      </div>
      <small className="muted">
        {[otp.issuer, otp.account].filter(Boolean).join(' · ') || '两步验证'} · {otp.digits} 位 · 每{' '}
        {otp.period} 秒
      </small>
      {showSecret && <code className="mono totp-secret">{value}</code>}
    </div>
  );
}
