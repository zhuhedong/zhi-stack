import { WORDS } from './wordlist';

export interface PasswordOptions {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
}
export interface PassphraseOptions {
  words: number;
  separator: string;
  capitalize: boolean;
  number: boolean;
}
const SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?/~',
};
const AMBIGUOUS = /[Il1O0o]/g;

/** Uniform integer in [0, max) from the CSPRNG (rejection sampling, no modulo bias). */
export function randomInt(max: number): number {
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0] < limit) return buffer[0] % max;
  }
}
export function generatePassword(options: PasswordOptions): string {
  const sets = (Object.keys(SETS) as (keyof typeof SETS)[])
    .filter((key) => options[key])
    .map((key) => (options.avoidAmbiguous ? SETS[key].replace(AMBIGUOUS, '') : SETS[key]));
  if (!sets.length) throw new Error('至少选择一种字符类型');
  const length = Math.min(128, Math.max(sets.length, Math.round(options.length)));
  const all = sets.join('');
  // One character from each chosen set, the rest from the union, then shuffle.
  const chars = sets.map((set) => set[randomInt(set.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
export function generatePassphrase(options: PassphraseOptions): string {
  const count = Math.min(12, Math.max(3, Math.round(options.words)));
  const words = Array.from({ length: count }, () => {
    const word = WORDS[randomInt(WORDS.length)];
    return options.capitalize ? word[0].toUpperCase() + word.slice(1) : word;
  });
  if (options.number) {
    const at = randomInt(words.length);
    words[at] += String(randomInt(10));
  }
  return words.join(options.separator);
}
export const passphraseBits = (options: PassphraseOptions) =>
  Math.round(
    Math.min(12, Math.max(3, options.words)) * Math.log2(WORDS.length) +
      (options.number ? Math.log2(10 * options.words) : 0),
  );

const COMMON = new Set(
  'password 123456 12345678 123456789 1234567890 qwerty qwerty123 abc123 111111 000000 iloveyou admin admin123 root toor letmein welcome monkey dragon football baseball sunshine princess master shadow passw0rd p@ssw0rd password1 password123 1q2w3e4r 1qaz2wsx zaq12wsx qwertyuiop asdfghjkl 123123 654321 666666 888888 woaini 5201314 a123456 aa123456 changeme test test123 guest'.split(
    ' ',
  ),
);
export interface Strength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  bits: number;
  reasons: string[];
}
/** Offline estimate: character-pool entropy with penalties for common patterns. */
export function passwordStrength(password: string): Strength {
  const reasons: string[] = [];
  if (!password) return { score: 0, label: '空', bits: 0, reasons: ['未设置密码'] };
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/\d/.test(password)) pool += 10;
  if (/[^A-Za-z0-9]/.test(password)) pool += 33;
  const unique = new Set(password).size;
  let bits = Math.log2(Math.max(pool, 2)) * Math.min(password.length, unique * 2);
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[\d!@#.]+$/, ''))) {
    bits = Math.min(bits, 10);
    reasons.push('属于常见密码');
  }
  if (/(.)\1{2,}/.test(password)) {
    bits -= 8;
    reasons.push('包含重复字符');
  }
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|qwer|asdf|zxcv)/i.test(password)) {
    bits -= 10;
    reasons.push('包含连续序列');
  }
  if (/^(19|20)\d{2}[01]\d[0-3]\d$/.test(password) || /^1[3-9]\d{9}$/.test(password)) {
    bits = Math.min(bits, 20);
    reasons.push('像日期或手机号');
  }
  if (password.length < 10) reasons.push('长度少于 10 位');
  bits = Math.max(0, Math.round(bits));
  const score = (bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4) as Strength['score'];
  return { score, bits, reasons, label: ['很弱', '弱', '一般', '强', '很强'][score] };
}

export interface CredentialSecret {
  itemId: string;
  title: string;
  field: string;
  value: string;
  updatedAt: string;
}
export interface HealthFinding {
  itemId: string;
  title: string;
  field: string;
  weak?: Strength;
  reusedWith?: string[];
  ageDays?: number;
}
/** Weak / reused / old report over decrypted secrets held in memory on this device. */
export function healthReport(secrets: CredentialSecret[], now = Date.now(), oldDays = 365): HealthFinding[] {
  const byValue = new Map<string, CredentialSecret[]>();
  for (const secret of secrets) {
    if (!secret.value) continue;
    byValue.set(secret.value, [...(byValue.get(secret.value) || []), secret]);
  }
  const findings: HealthFinding[] = [];
  for (const secret of secrets) {
    if (!secret.value) continue;
    const strength = passwordStrength(secret.value);
    const others = (byValue.get(secret.value) || [])
      .filter((s) => s !== secret)
      .map((s) => `${s.title} · ${s.field}`);
    const ageDays = Math.floor((now - new Date(secret.updatedAt).getTime()) / 86_400_000);
    const finding: HealthFinding = { itemId: secret.itemId, title: secret.title, field: secret.field };
    if (strength.score <= 1) finding.weak = strength;
    if (others.length) finding.reusedWith = others;
    if (ageDays >= oldDays) finding.ageDays = ageDays;
    if (finding.weak || finding.reusedWith || finding.ageDays) findings.push(finding);
  }
  return findings;
}
