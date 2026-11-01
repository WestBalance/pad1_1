import { createInterface } from 'node:readline/promises';
import { writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { makeChunks } from './processing.js';
import { readJson } from './grabber.js';

const labels = {
  sourceUrl: 'Начальная страница', maxDepth: 'Глубина обхода', restrictToSourcePath: 'Только каталог источника',
  maxPages: 'Лимит страниц', crawlDelay: 'Задержка обхода, мс', chunkStrategy: 'Метод chunking',
  chunkSize: 'Размер chunk, символы', chunkOverlap: 'Перекрытие, символы', embeddingModel: 'Embedding-модель',
  generationModel: 'Модель ответов', ollamaUrl: 'Адрес Ollama', qdrantUrl: 'Адрес Qdrant',
  collectionName: 'Префикс коллекций', topK: 'Количество результатов', similarityThreshold: 'Порог сходства',
  rerankerEnabled: 'Включить reranker', rerankerWeight: 'Вес reranker', promptVariant: 'Выбранный prompt',
  generationMode: 'Режим генерации', prompts: 'Тексты prompt', generationModes: 'Параметры режимов генерации',
  userAgent: 'Имя краулера', requestTimeout: 'Таймаут HTTP, мс', modelTimeout: 'Таймаут модели, мс',
  indexBatchSize: 'Размер пакета индексации', dataDirectory: 'Папка документов', experimentsDirectory: 'Папка экспериментов',
  noAnswer: 'Сообщение при отсутствии ответа', temperature: 'Температура', seed: 'Seed',
  num_predict: 'Лимит токенов ответа', num_ctx: 'Размер контекста, токены',
  evaluation: 'Эксперименты', questionIds: 'Номера вопросов ([] — все)', variantNames: 'Выбранные варианты ([] — все)',
  randomQuestions: 'Случайный выбор вопросов в меню', enabled: 'Включить',
  answerableCount: 'Количество вопросов с ответом', unanswerableCount: 'Количество вопросов без ответа',
  generateAnswers: 'Генерировать ответы при оценке', variants: 'Настройки вариантов экспериментов'
};

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function chooseQuestionIds(questions, settings) {
  const { answerableCount, unanswerableCount } = settings;
  if (![answerableCount, unanswerableCount].every(count => Number.isInteger(count) && count >= 0) || answerableCount + unanswerableCount === 0) throw new Error('Количество вопросов должно быть целым, неотрицательным; всего нужен хотя бы один вопрос.');
  const unique = [...new Map(questions.map(question => [question.id, question])).values()];
  const answerable = unique.filter(question => question.expectedUrls.length > 0);
  const unanswerable = unique.filter(question => question.expectedUrls.length === 0);
  if (answerable.length < answerableCount || unanswerable.length < unanswerableCount) throw new Error(`Недостаточно вопросов: доступно ${answerable.length} с ответом и ${unanswerable.length} без ответа.`);
  return shuffle([...shuffle(answerable).slice(0, answerableCount), ...shuffle(unanswerable).slice(0, unanswerableCount)]).map(question => question.id);
}

export function parseSetting(text, current) {
  if (typeof current === 'boolean') {
    if (['true', 'да', '1'].includes(text.toLowerCase())) return true;
    if (['false', 'нет', '0'].includes(text.toLowerCase())) return false;
    throw new Error('Введите true/false или да/нет.');
  }
  if (typeof current === 'number') {
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error('Введите число.');
    return value;
  }
  if (Array.isArray(current)) {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) throw new Error('Введите JSON-массив, например [4,7] или ["baseline"].');
    return value;
  }
  return text;
}

export async function saveConfig(config, filename = fileURLToPath(new URL('./config.js', import.meta.url))) {
  await writeFile(`${filename}.tmp`, `// Все настройки редактируются здесь или через npm start.\nexport default ${JSON.stringify(config, null, 2)};\n`, 'utf8');
  await rename(`${filename}.tmp`, filename);
}

async function editSettings(input, object, config, location = []) {
  while (true) {
    const keys = Object.keys(object);
    console.log(`\nНастройки${location.length ? ': ' + location.join('.') : ''}`);
    keys.forEach((key, index) => {
      const value = object[key];
      const display = value && typeof value === 'object' && !Array.isArray(value) ? '→' : JSON.stringify(value);
      console.log(`${index + 1}. ${labels[key] || key} (${key}): ${display?.slice(0, 100)}`);
    });
    if (Array.isArray(object)) console.log('a. Добавить вариант (JSON)');
    console.log('0. Назад');
    const choice = (await input.question('Выбор: ')).trim();
    if (choice === '0') return;
    try {
      if (choice === 'a' && Array.isArray(object)) {
        const value = JSON.parse(await input.question('Новый вариант, например {"name":"other","topK":10}: '));
        if (!value || typeof value !== 'object' || Array.isArray(value) || !value.name) throw new Error('Нужен объект с name.');
        const next = structuredClone(config);
        let target = next;
        for (const part of location) target = target[part];
        target.push(value);
        await saveConfig(next);
        object.push(value);
        console.log('Сохранено в src/config.js.');
        continue;
      }
      const key = keys[Number(choice) - 1];
      if (key === undefined) { console.log('Выберите номер из списка.'); continue; }
      const current = object[key];
      if (current && typeof current === 'object' && (!Array.isArray(current) || current.some(value => value && typeof value === 'object'))) {
        await editSettings(input, current, config, [...location, key]);
        continue;
      }
      let options;
      if (key === 'chunkStrategy') options = ['fixed', 'overlap'];
      if (key === 'promptVariant') options = Object.keys(config.prompts);
      if (key === 'generationMode') options = Object.keys(config.generationModes);
      console.log(`Текущее значение: ${JSON.stringify(current)}`);
      if (options) console.log(`Варианты: ${options.join(', ')}`);
      const text = (await input.question('Новое значение (Enter — отмена): ')).trim();
      if (!text) continue;
      const value = parseSetting(text, current);
      if (['maxPages', 'indexBatchSize', 'topK', 'requestTimeout', 'modelTimeout', 'chunkSize', 'num_predict', 'num_ctx'].includes(key) && (!Number.isInteger(value) || value < 1)) throw new Error('Нужно положительное целое число.');
      if (['maxDepth', 'crawlDelay', 'chunkOverlap', 'answerableCount', 'unanswerableCount'].includes(key) && (!Number.isInteger(value) || value < 0)) throw new Error('Нужно целое число не меньше нуля.');
      if (key === 'similarityThreshold' && (value < -1 || value > 1)) throw new Error('Порог Cosine должен быть от -1 до 1.');
      if (key === 'rerankerWeight' && (value < 0 || value > 1)) throw new Error('Вес должен быть от 0 до 1.');
      if (options && !options.includes(value)) throw new Error('Выберите один из перечисленных вариантов.');
      if (['sourceUrl', 'ollamaUrl', 'qdrantUrl'].includes(key) && !['http:', 'https:'].includes(new URL(value).protocol)) throw new Error('Нужен HTTP/HTTPS URL.');
      if (key === 'questionIds' && !value.every(id => Number.isInteger(id) && id > 0)) throw new Error('Нужен массив положительных целых номеров.');
      if (key === 'variantNames' && !value.every(name => config.evaluation.variants.some(item => item.name === name))) throw new Error('Название отсутствует в evaluation.variants.');
      const next = structuredClone(config);
      let target = next;
      for (const part of location) target = target[part];
      target[key] = value;
      if (['chunkStrategy', 'chunkSize', 'chunkOverlap'].includes(key)) makeChunks({ id: 'validation', text: '' }, { ...next, ...(location[0] === 'evaluation' && location[1] === 'variants' ? target : {}) });
      await saveConfig(next);
      object[key] = value;
      console.log('Сохранено в src/config.js.');
      const fullKey = [...location, key].join('.');
      if (['sourceUrl', 'maxDepth', 'restrictToSourcePath', 'maxPages'].includes(fullKey)) console.log('Далее: сбор страниц → индексация.');
      else if (['chunkStrategy', 'chunkSize', 'chunkOverlap', 'embeddingModel', 'collectionName', 'qdrantUrl', 'dataDirectory'].includes(fullKey)) console.log('Перед вопросами выполните индексацию. Старые коллекции автоматически не удаляются.');
      else console.log('Настройка применяется к следующим запускам.');
    } catch (error) { console.log(`Не сохранено: ${error.message}`); }
  }
}

export async function runMenu(config, actions) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      console.log('\nRAG — главное меню\n1. Все настройки\n2. Собрать страницы\n3. Проиндексировать документы\n4. Задать вопрос\n5. Запустить эксперименты\n0. Выход');
      const choice = (await input.question('Выбор: ')).trim();
      if (choice === '0') return;
      try {
        switch (choice) {
          case '1': await editSettings(input, config, config); break;
          case '2': await actions.grab(config); break;
          case '3': console.log(await actions.index(config)); break;
          case '4': {
            const question = (await input.question('Ваш вопрос: ')).trim();
            if (question) await actions.ask(question, config);
            break;
          }
          case '5': {
            if (config.evaluation.randomQuestions.enabled) {
              const questions = await readJson(path.join(config.experimentsDirectory, 'questions.json'), null);
              if (!Array.isArray(questions)) throw new Error('Не найден experiments/questions.json.');
              const ids = chooseQuestionIds(questions, config.evaluation.randomQuestions);
              const next = structuredClone(config);
              next.evaluation.questionIds = ids;
              await saveConfig(next);
              config.evaluation.questionIds = ids;
              console.log(`Случайная выборка: ${config.evaluation.randomQuestions.answerableCount} с ответом + ${config.evaluation.randomQuestions.unanswerableCount} без ответа. Номера сохранены в src/config.js.`);
            }
            console.log(`Вопросы: ${JSON.stringify(config.evaluation.questionIds)}; варианты: ${JSON.stringify(config.evaluation.variantNames)}; [] означает все.`);
            if ((await input.question('Запустить? (да/нет): ')).trim().toLowerCase() === 'да') await actions.evaluate(config);
            break;
          }
          default: console.log('Выберите номер из списка.');
        }
      } catch (error) { console.error(`Ошибка: ${error.message}${error.cause ? ` (${error.cause.message})` : ''}`); }
    }
  } finally { input.close(); }
}
