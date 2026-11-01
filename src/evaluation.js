import path from 'node:path';
import { readJson, saveJson, documentsFile } from './grabber.js';
import { indexDocuments } from './database.js';
import { retrieve } from './retrieval.js';
import { generate } from './generation.js';
import { hash } from './processing.js';

export function retrievalMetrics(hits, expectedUrls, topK = hits.length) {
  if (!expectedUrls.length) return null;
  hits = hits.slice(0, topK);
  const expected = new Set(expectedUrls);
  const relevant = hits.filter(hit => expected.has(hit.payload.url));
  const rank = hits.findIndex(hit => expectedUrls.includes(hit.payload.url)) + 1;
  return { precisionAtK: relevant.length / Math.max(1, topK), recallAtK: new Set(relevant.map(hit => hit.payload.url)).size / expected.size, reciprocalRank: rank > 0 ? 1 / rank : 0, hit: rank > 0 ? 1 : 0 };
}
export async function evaluate(config) {
  const allQuestions = await readJson(path.join(config.experimentsDirectory, 'questions.json'), null);
  const questions = allQuestions?.filter(item => !config.evaluation.questionIds.length || config.evaluation.questionIds.includes(item.id));
  const corpus = await readJson(documentsFile(config), { documents: [] });
  if (!questions?.length || !corpus.documents.length) throw new Error('Нужны documents.json и experiments/questions.json.');
  const documents = new Map(corpus.documents.map(d => [d.url, d]));
  for (const item of questions) for (const url of item.expectedUrls) {
    if (!documents.get(url)?.text.toLowerCase().includes(item.evidence.toLowerCase())) throw new Error(`Вопрос ${item.id}: подтверждающий текст не найден в собранном ${url}. Проверьте questions.json для текущего sourceUrl.`);
  }
  const file = path.join(config.experimentsDirectory, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const report = { startedAt: new Date().toISOString(), sourceUrl: config.sourceUrl, corpusHash: hash(JSON.stringify(corpus.documents.map(({ url, contentHash }) => ({ url, contentHash })))), runs: [] };
  const variants = config.evaluation.variants.filter(item => !config.evaluation.variantNames.length || config.evaluation.variantNames.includes(item.name));
  if (!variants.length) throw new Error('Нет выбранных вариантов экспериментов: проверьте evaluation.variantNames.');
  for (const variant of variants) {
    const settings = { ...config, ...variant };
    const run = { name: variant.name, settings: Object.fromEntries(['chunkStrategy', 'chunkSize', 'chunkOverlap', 'embeddingModel', 'generationModel', 'topK', 'similarityThreshold', 'rerankerEnabled', 'rerankerWeight', 'promptVariant', 'generationMode'].map(key => [key, settings[key]])), rows: [] };
    report.runs.push(run);
    console.log(`Эксперимент: ${variant.name}`);
    try {
      run.index = await indexDocuments(settings);
      for (const [index, item] of questions.entries()) {
        console.log(`\n[${index + 1}/${questions.length}] Вопрос ${item.id}: ${item.question}`);
        const start = Date.now();
        try {
          const hits = await retrieve(item.question, settings, run.index);
          const metrics = retrievalMetrics(hits, item.expectedUrls, settings.topK);
          const answer = config.evaluation.generateAnswers ? await generate(item.question, hits, settings) : null;
          const sources = answer ? answer.sources : [...new Map(hits.map(hit => [hit.payload.url, { title: hit.payload.title, url: hit.payload.url }])).values()];
          const correctRefusal = !item.expectedUrls.length && answer ? !answer.answered : null;
          run.rows.push({ questionId: item.id, question: item.question, answer: answer?.answer ?? null, sources, metrics, correctRefusal, milliseconds: Date.now() - start, manualQuality: null, manualNotes: '' });
          if (answer) {
            console.log(`Ответ: ${answer.answer}`);
            for (const source of answer.sources) console.log(`Источник: ${source.title}\n${source.url}`);
          } else {
            console.log(`Найдено фрагментов: ${hits.length}. Генерация отключена.`);
            for (const source of sources) console.log(`Источник: ${source.url}`);
          }
          if (metrics) console.log(`Оценка поиска: Precision@${settings.topK}=${metrics.precisionAtK.toFixed(3)}; Recall@${settings.topK}=${metrics.recallAtK.toFixed(3)}; RR=${metrics.reciprocalRank.toFixed(3)}; Hit=${metrics.hit}`);
          else console.log(`Оценка отказа: ${correctRefusal === null ? 'генерация отключена' : correctRefusal ? 'правильный отказ' : 'ошибочный ответ — ожидался отказ'}. Метрики поиска: н/д.`);
          console.log(`Время: ${((Date.now() - start) / 1000).toFixed(1)} с`);
        } catch (error) {
          run.rows.push({ questionId: item.id, question: item.question, error: error.message });
          console.error(`Ошибка в вопросе ${item.id}: ${error.message}`);
        }
        await saveJson(file, report);
      }
      const relevant = run.rows.filter(row => row.metrics);
      const negatives = run.rows.filter(row => typeof row.correctRefusal === 'boolean');
      run.summary = {
        precisionAtK: relevant.length ? relevant.reduce((s, r) => s + r.metrics.precisionAtK, 0) / relevant.length : null,
        recallAtK: relevant.length ? relevant.reduce((s, r) => s + r.metrics.recallAtK, 0) / relevant.length : null,
        hitRateAtK: relevant.length ? relevant.reduce((s, r) => s + r.metrics.hit, 0) / relevant.length : null,
        mrr: relevant.length ? relevant.reduce((s, r) => s + r.metrics.reciprocalRank, 0) / relevant.length : null,
        answerableEvaluated: relevant.length,
        errors: run.rows.filter(row => row.error).length,
        noAnswerAccuracy: negatives.length ? negatives.filter(row => row.correctRefusal).length / negatives.length : null
      };
      const format = value => value === null ? 'н/д' : value.toFixed(3);
      console.log(`\nИтоги ${variant.name}: Precision@${settings.topK}=${format(run.summary.precisionAtK)}; Recall@${settings.topK}=${format(run.summary.recallAtK)}; MRR=${format(run.summary.mrr)}; Hit Rate=${format(run.summary.hitRateAtK)}; правильные отказы=${format(run.summary.noAnswerAccuracy)}; ошибок=${run.summary.errors}`);
    } catch (error) { run.error = error.message; }
    await saveJson(file, report);
  }
  console.log(`Результаты: ${file}`);
  if (report.runs.some(run => run.error || run.rows.some(row => row.error))) throw new Error('Часть экспериментов не выполнена. Ошибки сохранены в отчёте.');
}
