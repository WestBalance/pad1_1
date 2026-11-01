import path from 'node:path';
import { readJson, saveJson, documentsFile } from './grabber.js';
import { indexDocuments } from './database.js';
import { retrieve } from './retrieval.js';
import { generate } from './generation.js';

export function retrievalMetrics(hits, expectedUrls) {
  const rank = hits.findIndex(hit => expectedUrls.includes(hit.payload.url)) + 1;
  return { hit: rank > 0 ? 1 : 0, reciprocalRank: rank > 0 ? 1 / rank : 0 };
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
  const report = { startedAt: new Date().toISOString(), corpus: corpus.documents.map(({ url, contentHash }) => ({ url, contentHash })), runs: [] };
  const variants = config.evaluation.variants.filter(item => !config.evaluation.variantNames.length || config.evaluation.variantNames.includes(item.name));
  if (!variants.length) throw new Error('Нет выбранных вариантов экспериментов: проверьте evaluation.variantNames.');
  for (const variant of variants) {
    const settings = { ...config, ...variant };
    const run = { name: variant.name, settings, rows: [] };
    report.runs.push(run);
    console.log(`Эксперимент: ${variant.name}`);
    try {
      run.index = await indexDocuments(settings);
      for (const item of questions) {
        const start = Date.now();
        try {
          const hits = await retrieve(item.question, settings, run.index);
          const metrics = item.expectedUrls.length ? retrievalMetrics(hits, item.expectedUrls) : null;
          const answer = config.evaluation.generateAnswers ? await generate(item.question, hits, settings) : null;
          run.rows.push({ questionId: item.id, question: item.question, expectedUrls: item.expectedUrls, hits: hits.map(hit => ({ url: hit.payload.url, text: hit.payload.text, score: hit.score, rerankScore: hit.rerankScore })), metrics, answer, milliseconds: Date.now() - start, manualQuality: null, manualNotes: '' });
        } catch (error) { run.rows.push({ questionId: item.id, error: error.message }); }
        await saveJson(file, report);
        console.log(`Вопрос ${item.id}: ${run.rows.at(-1).error ? 'ошибка' : 'готово'}`);
      }
      const relevant = run.rows.filter(row => row.metrics);
      const negatives = run.rows.filter(row => row.answer && !row.expectedUrls.length);
      run.summary = {
        hitRateAtK: relevant.length ? relevant.reduce((s, r) => s + r.metrics.hit, 0) / relevant.length : null,
        mrr: relevant.length ? relevant.reduce((s, r) => s + r.metrics.reciprocalRank, 0) / relevant.length : null,
        answerableEvaluated: relevant.length,
        errors: run.rows.filter(row => row.error).length,
        noAnswerAccuracy: negatives.length ? negatives.filter(row => !row.answer.answered).length / negatives.length : null
      };
    } catch (error) { run.error = error.message; }
    await saveJson(file, report);
  }
  console.log(`Результаты: ${file}`);
  if (report.runs.some(run => run.error || run.rows.some(row => row.error))) throw new Error('Часть экспериментов не выполнена. Ошибки сохранены в отчёте.');
}
