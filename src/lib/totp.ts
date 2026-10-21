/** RFC 6238 TOTP (otpauth:// URIs or bare base32 secrets), computed locally with WebCrypto. */
export interface OtpParams {
  secret: Uint8Array;
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
  digits: number;
  period: number;
  issuer: string;
  account: string;
}

export function base32Decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('TOTP 密钥必须是 Base32（A–Z、2–7）');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function parseOtp(value: string): OtpParams {
  const text = value.trim();
  if (!/^otpauth:/i.test(text))
    return { secret: base32Decode(text), algorithm: 'SHA-1', digits: 6, period: 30, issuer: '', account: '' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('otpauth 链接格式无效');
  }
  if (url.hostname.toLowerCase() !== 'totp' && !/^\/\/totp\//i.test(url.pathname))
    throw new Error('只支持基于时间的 TOTP（otpauth://totp/…）');
  const params = url.searchParams;
  const label = decodeURIComponent(url.pathname.replace(/^\/+(totp\/)?/i, ''));
  const [labelIssuer, account] = label.includes(':') ? label.split(/:(.*)/s) : ['', label];
  const algorithm = (params.get('algorithm') || 'SHA1').toUpperCase().replace('SHA', 'SHA-');
  if (!['SHA-1', 'SHA-256', 'SHA-512'].includes(algorithm)) throw new Error('不支持的 TOTP 算法');
  const digits = Number(params.get('digits') || 6);
  const period = Number(params.get('period') || 30);
  if (![6, 7, 8].includes(digits) || !(period >= 10 && period <= 300)) throw new Error('TOTP 位数或周期无效');
  return {
    secret: base32Decode(params.get('secret') || ''),
    algorithm: algorithm as OtpParams['algorithm'],
    digits,
    period,
    issuer: params.get('issuer') || labelIssuer.trim(),
    account: account.trim(),
  };
}

export async function totpCode(params: OtpParams, now = Date.now()): Promise<string> {
  const counter = Math.floor(now / 1000 / params.period);
  const message = new ArrayBuffer(8);
  const view = new DataView(message);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey(
    'raw',
    params.secret as BufferSource,
    { name: 'HMAC', hash: params.algorithm },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** params.digits).padStart(params.digits, '0');
}
export const secondsLeft = (period: number, now = Date.now()) => period - (Math.floor(now / 1000) % period);

/** Decode a QR code image (otpauth:// link) locally. */
export async function readQrImage(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const { default: jsQR } = await import('jsqr');
  const found = jsQR(pixels.data, pixels.width, pixels.height);
  if (!found?.data) throw new Error('图片中没有识别到二维码');
  if (!/^otpauth:\/\/totp\//i.test(found.data)) throw new Error('二维码不是 TOTP 两步验证链接');
  return found.data;
}
