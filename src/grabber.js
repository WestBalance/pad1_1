import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import robotsParser from 'robots-parser';
import { hash, stableId, normalizeUrl, parseHtml } from './processing.js';

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await rename(`${file}.tmp`, file);
}
export const documentsFile = config => path.join(config.dataDirectory, 'documents.json');
export function inScope(value, config) {
  const source = new URL(config.sourceUrl);
  const url = new URL(value);
  const prefix = source.pathname.endsWith('/') ? source.pathname : source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1);
  return url.origin === source.origin && (!config.restrictToSourcePath || url.pathname.startsWith(prefix));
}
export async function grab(config) {
  const sourceUrl = normalizeUrl(config.sourceUrl);
  if (!sourceUrl) throw new Error('Некорректный sourceUrl.');
  const previous = await readJson(documentsFile(config), { documents: [] });
  const documents = new Map((previous.sourceUrl === sourceUrl ? previous.documents : []).filter(d => inScope(d.url, config) && (d.depth ?? 0) <= config.maxDepth).map(d => [d.url, d]));
  const robotsUrl = new URL('/robots.txt', sourceUrl).href;
  const robotsResponse = await fetch(robotsUrl, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(config.requestTimeout), redirect: 'error' });
  if (!robotsResponse.ok && robotsResponse.status !== 404) throw new Error(`robots.txt: HTTP ${robotsResponse.status}; обход отменён.`);
  const robots = robotsParser(robotsUrl, robotsResponse.status === 404 ? '' : await robotsResponse.text());
  const delay = Math.max(config.crawlDelay, (robots.getCrawlDelay(config.userAgent) || 0) * 1000);
  const queue = [{ url: sourceUrl, depth: 0 }];
  const seen = new Set();
  let count = 0;
  let lastRequest = Date.now();
  let changed = 0;
  for (let cursor = 0; cursor < queue.length && count < config.maxPages; cursor++) {
    const { url, depth } = queue[cursor];
    if (seen.has(url) || !inScope(url, config)) continue;
    seen.add(url);
    if (robots.isAllowed(url, config.userAgent) === false) { documents.delete(url); console.log(`robots.txt: пропуск ${url}`); continue; }
    if (/\.(?:pdf|zip|png|jpg|jpeg|gif|svg|css|js|xml|txt)$/i.test(new URL(url).pathname)) continue;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, lastRequest + delay - Date.now())));
    lastRequest = Date.now();
    count++;
    try {
      const response = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(config.requestTimeout), redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        documents.delete(url);
        const target = normalizeUrl(response.headers.get('location'), url);
        if (target && inScope(target, config)) queue.push({ url: target, depth });
        console.log(`Перенаправление: ${url}`);
        continue;
      }
      if (!response.ok) {
        if ([404, 410].includes(response.status)) documents.delete(url);
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.headers.get('content-type')?.includes('text/html')) continue;
      const { title, text, links } = parseHtml(await response.text(), url);
      if (!text) throw new Error('Пустой текст');
      const contentHash = hash(`${title}\n${text}`);
      const old = documents.get(url);
      if (old?.contentHash !== contentHash) {
        changed++;
        documents.set(url, { id: stableId(url), url, title, text, contentHash, depth, fetchedAt: new Date().toISOString() });
        console.log(`${old ? 'Изменён' : 'Новый'}: ${url}`);
      } else { documents.set(url, { ...old, depth }); console.log(`Без изменений: ${url}`); }
      if (depth < config.maxDepth) for (const link of links) if (inScope(link, config)) queue.push({ url: link, depth: depth + 1 });
    } catch (error) { console.log(`Пропуск ${url}: ${error.message}`); }
  }
  await saveJson(documentsFile(config), { sourceUrl, grabbedAt: new Date().toISOString(), documents: [...documents.values()] });
  console.log(`Запросов: ${count}; новых/изменённых: ${changed}; сохранено: ${documents.size}.`);
  return [...documents.values()];
}
