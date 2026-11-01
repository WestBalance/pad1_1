import path from 'node:path';
import { hash, makeChunks } from './processing.js';
import { embed, embedMany, modelIdentity, requestJson } from './embeddings.js';
import { readJson, saveJson, documentsFile } from './grabber.js';

export async function indexIdentity(config) {
  const digest = await modelIdentity(config);
  const signature = hash(JSON.stringify({ source: config.sourceUrl, model: config.embeddingModel, digest, strategy: config.chunkStrategy, size: config.chunkSize, overlap: config.chunkStrategy === 'overlap' ? config.chunkOverlap : 0, processingVersion: 1 }));
  return { signature, collection: `${config.collectionName}_${signature.slice(0, 16)}`, digest };
}
const endpoint = (config, collection) => `${config.qdrantUrl}/collections/${encodeURIComponent(collection)}`;
export async function indexDocuments(config) {
  if (!Number.isInteger(config.indexBatchSize) || config.indexBatchSize < 1) throw new Error('indexBatchSize должен быть положительным целым числом.');
  const { documents } = await readJson(documentsFile(config), { documents: [] });
  if (!documents.length) throw new Error('Нет документов. Сначала npm run grab.');
  const identity = await indexIdentity(config);
  const stateFile = path.join(config.dataDirectory, `index-${identity.collection}.json`);
  let state = await readJson(stateFile, { documents: {} });
  const url = endpoint(config, identity.collection);
  try { await requestJson(url, undefined, config.requestTimeout); }
  catch (error) {
    if (error.status !== 404) throw error;
    const vector = await embed(documents[0].text.slice(0, config.chunkSize), config);
    await requestJson(url, { vectors: { size: vector.length, distance: 'Cosine' } }, config.requestTimeout, 'PUT');
    state = { documents: {} };
    await saveJson(stateFile, state);
  }
  makeChunks(documents[0], config);
  const currentIds = new Set(documents.map(d => d.id));
  for (const id of Object.keys(state.documents)) if (!currentIds.has(id)) {
    await deleteDocument(url, id, config);
    delete state.documents[id];
    await saveJson(stateFile, state);
  }
  for (const document of documents) {
    if (state.documents[document.id] === document.contentHash) continue;
    const chunks = makeChunks(document, config);
    // До получения embeddings старый индекс не трогаем.
    const points = [];
    for (let start = 0; start < chunks.length; start += config.indexBatchSize) {
      const batch = chunks.slice(start, start + config.indexBatchSize);
      const vectors = await embedMany(batch.map(chunk => chunk.text), config);
      points.push(...batch.map((chunk, i) => ({ id: chunk.id, vector: vectors[i], payload: chunk })));
    }
    await deleteDocument(url, document.id, config);
    for (let start = 0; start < points.length; start += config.indexBatchSize) {
      await requestJson(`${url}/points?wait=true`, { points: points.slice(start, start + config.indexBatchSize) }, config.requestTimeout, 'PUT');
    }
    state.documents[document.id] = document.contentHash;
    await saveJson(stateFile, state);
    console.log(`Индекс: ${document.title} (${chunks.length} chunks)`);
  }
  await saveJson(stateFile, { ...state, ...identity });
  return identity;
}
async function deleteDocument(url, id, config) {
  await requestJson(`${url}/points/delete?wait=true`, { filter: { must: [{ key: 'documentId', match: { value: id } }] } }, config.requestTimeout);
}
export async function requireIndex(config) {
  const identity = await indexIdentity(config);
  const state = await readJson(path.join(config.dataDirectory, `index-${identity.collection}.json`), null);
  const { documents } = await readJson(documentsFile(config), { documents: [] });
  if (!state || !documents.length || Object.keys(state.documents).length !== documents.length || documents.some(d => state.documents[d.id] !== d.contentHash)) throw new Error('Индекс отсутствует или устарел. Выполните npm run index.');
  return identity;
}
export async function searchVector(vector, identity, config) {
  const response = await requestJson(`${endpoint(config, identity.collection)}/points/query`, { query: vector, limit: config.topK, score_threshold: config.similarityThreshold, with_payload: true }, config.requestTimeout);
  return response.result.points;
}
