import { embed } from './embeddings.js';
import { searchVector, requireIndex } from './database.js';

export function rerank(question, hits, config) {
  const tokens = new Set(question.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []);
  return hits.map(hit => {
    const words = new Set(`${hit.payload.title} ${hit.payload.text}`.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []);
    const overlap = [...tokens].filter(token => words.has(token)).length / Math.max(1, tokens.size);
    return { ...hit, rerankScore: (1 - config.rerankerWeight) * hit.score + config.rerankerWeight * overlap };
  }).sort((a, b) => b.rerankScore - a.rerankScore);
}
export async function retrieve(question, config, identity) {
  identity ||= await requireIndex(config);
  const hits = await searchVector(await embed(question, config), identity, config);
  const texts = new Set();
  const unique = hits.filter(hit => {
    if (texts.has(hit.payload.text)) return false;
    texts.add(hit.payload.text);
    return true;
  });
  return config.rerankerEnabled ? rerank(question, unique, config) : unique;
}
