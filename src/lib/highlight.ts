import { createLowlight } from 'lowlight';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import type { ReactNode } from 'react';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import http from 'highlight.js/lib/languages/http';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import ini from 'highlight.js/lib/languages/ini';
import dockerfile from 'highlight.js/lib/languages/dockerfile';

/** Languages bundled for highlighting; everything else stays plain text. */
export const languages = {
  bash,
  css,
  diff,
  dockerfile,
  go,
  http,
  ini,
  java,
  javascript,
  json,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};
export const aliases: Record<string, string[]> = {
  bash: ['sh', 'shell', 'zsh', 'console'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  typescript: ['ts', 'tsx'],
  python: ['py'],
  rust: ['rs'],
  xml: ['html', 'svg', 'vue'],
  yaml: ['yml'],
  ini: ['toml', 'conf'],
  dockerfile: ['docker'],
};
/** Larger blocks are shown as plain text to keep the UI responsive. */
export const HIGHLIGHT_LIMIT = 200_000;

export const lowlight = createLowlight(languages);
lowlight.registerAlias(aliases);

export function highlight(code: string, language?: string): ReactNode | null {
  if (!language || code.length > HIGHLIGHT_LIMIT || !lowlight.registered(language)) return null;
  return toJsxRuntime(lowlight.highlight(language, code), { Fragment, jsx, jsxs });
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}
const textOf = (n: HastNode): string => (n.value ?? '') + (n.children || []).map(textOf).join('');

/**
 * Minimal rehype plugin: highlights <pre><code class="language-x"> with the
 * bundled lowlight grammars only (rehype-highlight would pull in lowlight's
 * full "common" set). No auto-detection; oversized blocks stay plain.
 */
export function rehypeCodeHighlight() {
  return (tree: HastNode) => {
    const walk = (n: HastNode, parent?: HastNode) => {
      if (n.tagName === 'code' && parent?.tagName === 'pre') {
        const p = (n.properties ||= {});
        const cls = Array.isArray(p.className) ? (p.className as unknown[]).map(String) : [];
        const lang = cls.find((c) => c.startsWith('language-'))?.slice(9);
        const text = textOf(n);
        if (lang && text.length <= HIGHLIGHT_LIMIT && lowlight.registered(lang)) {
          n.children = lowlight.highlight(lang, text).children as HastNode[];
          p.className = [...cls, 'hljs'];
        }
        return;
      }
      n.children?.forEach((c) => walk(c, n));
    };
    walk(tree);
  };
}

const labels: Record<string, string> = {
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  javascript: 'JavaScript',
  json: 'JSON',
  bash: 'Shell',
  sh: 'Shell',
  shell: 'Shell',
  sql: 'SQL',
  rust: 'Rust',
  rs: 'Rust',
  python: 'Python',
  py: 'Python',
  go: 'Go',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  html: 'HTML',
  xml: 'XML',
  css: 'CSS',
  diff: 'Diff',
  http: 'HTTP',
  java: 'Java',
  dockerfile: 'Dockerfile',
};
export const languageLabel = (lang?: string) => (lang ? labels[lang.toLowerCase()] || lang : '');
