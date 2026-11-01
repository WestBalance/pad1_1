import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import config from '../src/config.js';
import { indexDocuments } from '../src/database.js';
import { saveJson, documentsFile } from '../src/grabber.js';
import { hash, stableId } from '../src/processing.js';

test('index skips unchanged documents, replaces old chunks, isolates models and recovers after failed write', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rag-lab-test-'));
  const settings = { ...config, dataDirectory: directory, chunkSize: 6, chunkOverlap: 2 };
  const collections = new Map();
  let embeddingCalls = 0;
  let failWrite = false;
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('rag-lab-test-'));
    await rm(directory, { recursive: true });
  });
  globalThis.fetch = async (address, options = {}) => {
    const url = new URL(address);
    const body = options.body ? JSON.parse(options.body) : {};
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.pathname === '/api/tags') return json({ models: [{ name: settings.embeddingModel + ':latest', digest: 'model-a' }, { name: 'second:latest', digest: 'model-b' }] });
    if (url.pathname === '/api/embed') { embeddingCalls++; return json({ embeddings: body.input.map(() => [1, 0, 0]) }); }
    const [, , name, , operation] = url.pathname.split('/');
    if (url.pathname === `/collections/${name}`) {
      if (options.method === 'PUT') { collections.set(name, new Map()); return json({ result: true }); }
      return collections.has(name) ? json({ result: {} }) : json({}, 404);
    }
    const points = collections.get(name);
    if (operation === 'delete') for (const [id, point] of points) {
      if (point.payload.documentId === body.filter.must[0].match.value) points.delete(id);
    }
    else {
      if (failWrite) return json({ error: 'simulated interruption' }, 500);
      for (const point of body.points) points.set(point.id, point);
    }
    return json({ result: true });
  };
  const url = 'https://example.com/tutorial/page';
  const store = async text => saveJson(documentsFile(settings), { documents: [{ id: stableId(url), url, title: 'Example', text, contentHash: hash(text) }] });
  await store('0123456789abcdef');
  const first = await indexDocuments(settings);
  assert.equal(collections.get(first.collection).size, 4);
  const calls = embeddingCalls;
  await indexDocuments(settings);
  assert.equal(embeddingCalls, calls);
  await store('abc');
  failWrite = true;
  await assert.rejects(indexDocuments(settings), /HTTP 500/);
  failWrite = false;
  await indexDocuments(settings);
  assert.equal(collections.get(first.collection).size, 1);
  assert.equal([...collections.get(first.collection).values()][0].payload.text, 'abc');
  const second = await indexDocuments({ ...settings, embeddingModel: 'second' });
  assert.notEqual(first.collection, second.collection);
  const third = await indexDocuments({ ...settings, chunkStrategy: 'fixed' });
  assert.notEqual(first.collection, third.collection);
});
