import { requestJson } from './embeddings.js';

export async function generate(question, hits, config) {
  const refusal = { answer: config.noAnswer, answered: false, sources: [] };
  if (!hits.length) return refusal;
  const context = hits.map((hit, i) => `[${i + 1}] ${hit.payload.title}\n${hit.payload.text}`).join('\n\n');
  const result = await requestJson(`${config.ollamaUrl}/api/chat`, {
    model: config.generationModel, stream: false, think: false,
    format: { type: 'object', properties: { answered: { type: 'boolean' }, answer: { type: 'string' }, sourceIds: { type: 'array', items: { type: 'integer' } } }, required: ['answered', 'answer', 'sourceIds'] },
    options: config.generationModes[config.generationMode],
    messages: [{ role: 'system', content: config.prompts[config.promptVariant] }, { role: 'user', content: `КОНТЕКСТ:\n${context}\n\nВОПРОС: ${question}` }]
  }, config.modelTimeout);
  let answer;
  try { answer = JSON.parse(result.message.content); } catch { return refusal; }
  if (!answer.answered || !answer.answer?.trim() || !Array.isArray(answer.sourceIds) || !answer.sourceIds.length || answer.sourceIds.some(id => !Number.isInteger(id) || id < 1 || id > hits.length)) return refusal;
  const sources = [...new Map(answer.sourceIds.map(id => [hits[id - 1].payload.url, { url: hits[id - 1].payload.url, title: hits[id - 1].payload.title }])).values()];
  return { answered: true, answer: answer.answer, sources };
}
