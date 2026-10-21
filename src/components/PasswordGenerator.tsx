import { useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import {
  generatePassphrase,
  generatePassword,
  passphraseBits,
  passwordStrength,
  type PassphraseOptions,
  type PasswordOptions,
} from '../lib/passwords';

/** Password / passphrase generator (local CSPRNG). */
export function PasswordGenerator({
  onUse,
  onClose,
}: {
  onUse: (value: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'password' | 'passphrase'>('password');
  const [options, setOptions] = useState<PasswordOptions>({
    length: 20,
    lower: true,
    upper: true,
    digits: true,
    symbols: true,
    avoidAmbiguous: false,
  });
  const [phrase, setPhrase] = useState<PassphraseOptions>({
    words: 5,
    separator: '-',
    capitalize: true,
    number: true,
  });
  const make = (m = mode, o = options, p = phrase) => {
    try {
      return m === 'password' ? generatePassword(o) : generatePassphrase(p);
    } catch {
      return '';
    }
  };
  const [value, setValue] = useState(() => make());
  const update = (m: typeof mode, o: PasswordOptions, p: PassphraseOptions) => {
    setMode(m);
    setOptions(o);
    setPhrase(p);
    setValue(make(m, o, p));
  };
  const strength = passwordStrength(value);
  const bits = mode === 'passphrase' ? passphraseBits(phrase) : strength.bits;
  const toggle = (key: keyof Omit<PasswordOptions, 'length'>, label: string) => (
    <label className="checkbox-row">
      <input
        type="checkbox"
        checked={options[key]}
        onChange={(e) => update(mode, { ...options, [key]: e.target.checked }, phrase)}
      />
      {label}
    </label>
  );
  return (
    <div className="password-generator" role="group" aria-label="密码生成器">
      <div className="section-title">
        <div className="segmented">
          <button
            type="button"
            className={mode === 'password' ? 'active' : ''}
            onClick={() => update('password', options, phrase)}
          >
            随机密码
          </button>
          <button
            type="button"
            className={mode === 'passphrase' ? 'active' : ''}
            onClick={() => update('passphrase', options, phrase)}
          >
            助记口令
          </button>
        </div>
        <button type="button" className="icon-button" aria-label="关闭生成器" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="generated-value">
        <code className="mono" aria-label="生成的密码">
          {value || '至少选择一种字符类型'}
        </code>
        <button type="button" className="icon-button" aria-label="重新生成" onClick={() => setValue(make())}>
          <RefreshCw size={13} />
        </button>
      </div>
      <small className={'strength s' + (mode === 'passphrase' ? 4 : strength.score)}>
        {mode === 'passphrase' ? '很强' : strength.label} · 约 {bits} 位熵
      </small>
      {mode === 'password' ? (
        <div className="generator-options">
          <label>
            长度 {options.length}
            <input
              type="range"
              min={8}
              max={64}
              value={options.length}
              onChange={(e) => update(mode, { ...options, length: Number(e.target.value) }, phrase)}
            />
          </label>
          {toggle('lower', '小写 a-z')}
          {toggle('upper', '大写 A-Z')}
          {toggle('digits', '数字 0-9')}
          {toggle('symbols', '符号 !@#')}
          {toggle('avoidAmbiguous', '排除易混淆字符 (I l 1 O 0)')}
        </div>
      ) : (
        <div className="generator-options">
          <label>
            单词数 {phrase.words}
            <input
              type="range"
              min={3}
              max={10}
              value={phrase.words}
              onChange={(e) => update(mode, options, { ...phrase, words: Number(e.target.value) })}
            />
          </label>
          <label>
            分隔符
            <select
              value={phrase.separator}
              onChange={(e) => update(mode, options, { ...phrase, separator: e.target.value })}
            >
              <option value="-">-</option>
              <option value=".">.</option>
              <option value="_">_</option>
              <option value=" ">空格</option>
            </select>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={phrase.capitalize}
              onChange={(e) => update(mode, options, { ...phrase, capitalize: e.target.checked })}
            />
            首字母大写
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={phrase.number}
              onChange={(e) => update(mode, options, { ...phrase, number: e.target.checked })}
            />
            加入数字
          </label>
        </div>
      )}
      <div className="inline-actions">
        <button type="button" className="primary" disabled={!value} onClick={() => onUse(value)}>
          使用此密码
        </button>
      </div>
    </div>
  );
}
