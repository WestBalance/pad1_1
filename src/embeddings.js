export async function requestJson(url, body, timeout = 30000, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${url} ${(await response.text()).slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}
export async function embed(text, config) {
  return (await embedMany([text], config))[0];
}
export async function embedMany(texts, config) {
  const result = await requestJson(`${config.ollamaUrl}/api/embed`, { model: config.embeddingModel, input: texts, truncate: false }, config.modelTimeout);
  if (result.embeddings?.length !== texts.length || result.embeddings.some(vector => !vector.length)) throw new Error('Ollama не вернула embeddings. Проверьте embeddingModel.');
  return result.embeddings;
}
export async function modelIdentity(config) {
  const { models } = await requestJson(`${config.ollamaUrl}/api/tags`, undefined, config.requestTimeout);
  const model = models.find(item => item.name === config.embeddingModel || item.name === `${config.embeddingModel}:latest`);
  if (!model) throw new Error(`Модель не установлена: ollama pull ${config.embeddingModel}`);
  return model.digest;
}
