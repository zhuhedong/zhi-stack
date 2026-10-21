const normalize = (s: string) => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Drop a leading H1 (ATX `# x` or setext `x\n===`) that just repeats the item title. Display only. */
export function stripLeadingTitle(markdown: string, title: string): string {
  const want = normalize(title);
  if (!want) return markdown;
  const atx = markdown.match(/^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/);
  if (atx && normalize(atx[1]) === want) return markdown.slice(atx[0].length).replace(/^\s*\n/, '');
  const setext = markdown.match(/^\s*([^\n]+)\r?\n=+[ \t]*(?:\r?\n|$)/);
  if (setext && normalize(setext[1]) === want) return markdown.slice(setext[0].length).replace(/^\s*\n/, '');
  return markdown;
}

/** Plain-text preview of Markdown: removes fenced code markers, inline code ticks, headings, links and emphasis. */
export function markdownSnippet(markdown: string): string {
  return (
    markdown
      .replace(/^[ \t]*(```|~~~)[^\n]*$/gm, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      // Snippets are cut mid-text: drop a trailing, unterminated image or link target.
      .replace(/!\[[^\]]*\](\([^)]*)?…?$/, '…')
      .replace(/\[([^\]]*)\]\([^)]*…?$/, '$1…')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^[ \t]*(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+)/gm, '')
      .replace(/^[ \t]*(=+|-+)[ \t]*$/gm, ' ')
      .replace(/(\*\*|__|\*|_|~~)(\S[^*_~]*?)\1/g, '$2')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
