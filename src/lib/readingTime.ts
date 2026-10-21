const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

/** Minutes to read: ~400 CJK characters/min plus ~200 Latin words/min. 0 for empty text. */
export function readingMinutes(markdown: string): number {
  const text = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/<[^>]+>/g, ' ');
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.replace(CJK, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’_-]*/g)?.length ?? 0;
  const minutes = cjk / 400 + words / 200;
  return minutes === 0 ? 0 : Math.max(1, Math.round(minutes));
}
export function minutesLabel(minutes: number | undefined): string {
  return minutes ? `约 ${minutes} 分钟` : '';
}
export function readingLabel(markdown: string | undefined): string {
  return minutesLabel(readingMinutes(markdown || ''));
}
/** List rows carry a server-computed `readingMinutes` instead of the full body. */
export function itemReadingLabel(data: { content?: string; readingMinutes?: number }): string {
  return typeof data.readingMinutes === 'number'
    ? minutesLabel(data.readingMinutes)
    : readingLabel(data.content);
}
