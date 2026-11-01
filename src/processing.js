import { createHash } from 'node:crypto';
import { load } from 'cheerio';

export const hash = text => createHash('sha256').update(text).digest('hex');
export function stableId(text) {
  const h = hash(text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
export function normalizeUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    url.search = '';
    return url.href;
  } catch { return null; }
}
export function parseHtml(html, url) {
  const $ = load(html);
  const links = [...new Set($('a[href]').map((_, a) => normalizeUrl($(a).attr('href'), url)).get().filter(Boolean))];
  const title = $('title').first().text().trim() || $('h1').first().text().trim() || url;
  $('script,style,noscript,nav,header,footer,aside,form,[role="navigation"],[hidden],.headerlink').remove();
  const main = $('main').first().length ? $('main').first() : $('[role="main"]').first().length ? $('[role="main"]').first() : $('article').first().length ? $('article').first() : $('body');
  main.find('p,div,section,li,pre,h1,h2,h3,h4,br,tr').before('\n').after('\n');
  const text = main.text().replace(/\s+/gu, ' ').trim();
  return { title, text, links };
}
export function makeChunks(document, config) {
  const { chunkSize, chunkStrategy, chunkOverlap } = config;
  if (!['fixed', 'overlap'].includes(chunkStrategy) || !Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('Некорректные параметры chunking.');
  const overlap = chunkStrategy === 'overlap' ? chunkOverlap : 0;
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) throw new Error('chunkOverlap должен быть >= 0 и < chunkSize.');
  const chars = Array.from(document.text);
  const chunks = [];
  for (let start = 0; start < chars.length; start += chunkSize - overlap) {
    const text = chars.slice(start, start + chunkSize).join('');
    chunks.push({ id: stableId(`${document.id}:${start}`), documentId: document.id, url: document.url, title: document.title, start, text });
    if (start + chunkSize >= chars.length) break;
  }
  return chunks;
}
