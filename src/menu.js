import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { readJson } from './grabber.js';

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

export function applyPreset(current, base, group, name) {
  const preset = base.evaluation.variants.find(item => item.name === name);
  if (!group.variants.includes(name) || !preset) throw new Error('Пресет не найден.');
  const next = structuredClone(current);
  for (const field of group.fields) next[field] = preset[field] ?? base[field];
  return next;
}

function describe(settings, group) {
  const labels = { chunkStrategy: 'метод', chunkSize: 'размер', chunkOverlap: 'overlap', topK: 'topK', rerankerEnabled: 'reranker', similarityThreshold: 'порог', promptVariant: 'prompt', generationMode: 'режим' };
  return group.fields.map(field => {
    let value = settings[field];
    if (typeof value === 'boolean') value = value ? 'включён' : 'выключен';
    if (field === 'chunkStrategy') value = value === 'fixed' ? 'без перекрытия' : 'с перекрытием';
    if (field === 'chunkOverlap' && settings.chunkStrategy === 'fixed') value = 0;
    return `${labels[field] || field}: ${value}`;
  }).join(', ');
}

export async function runMenu(config, actions, input = createInterface({ input: process.stdin, output: process.stdout })) {
  const base = structuredClone(config);
  let settings = structuredClone(base);
  const offset = base.menuGroups.length;
  try {
    while (true) {
      console.log('\nRAG — пресеты текущего запуска');
      base.menuGroups.forEach((group, index) => console.log(`${index + 1}. ${group.title} — ${describe(settings, group)}`));
      console.log(`${offset + 1}. Собрать страницы\n${offset + 2}. Проиндексировать документы\n${offset + 3}. Задать вопрос\n${offset + 4}. Запустить эксперимент\n${offset + 5}. Сбросить выбор\n0. Выход`);
      const text = (await input.question('Выбор: ')).trim();
      if (text === '0') return;
      const choice = Number(text);
      try {
        if (Number.isInteger(choice) && choice >= 1 && choice <= offset) {
          const group = base.menuGroups[choice - 1];
          console.log(`\n${group.title}`);
          group.variants.forEach((name, index) => console.log(`${index + 1}. ${describe(applyPreset(settings, base, group, name), group)}`));
          console.log('0. Назад');
          const selected = Number((await input.question('Вариант: ')).trim());
          if (selected === 0) continue;
          const name = Number.isInteger(selected) ? group.variants[selected - 1] : undefined;
          if (!name) throw new Error('Выберите номер из списка.');
          settings = applyPreset(settings, base, group, name);
          console.log(`Выбрано: ${describe(settings, group)}. Действует до выхода из меню.`);
          continue;
        }
        switch (choice - offset) {
          case 1: await actions.grab(settings); break;
          case 2: console.log(await actions.index(settings)); break;
          case 3: {
            const question = (await input.question('Ваш вопрос: ')).trim();
            if (question) {
              console.log('Подготовка индекса для выбранных пресетов...');
              await actions.index(settings);
              await actions.ask(question, settings);
            }
            break;
          }
          case 4: {
            const experiment = structuredClone(settings);
            if (experiment.evaluation.randomQuestions.enabled) {
              const questions = await readJson(path.join(experiment.experimentsDirectory, 'questions.json'), null);
              if (!Array.isArray(questions)) throw new Error('Не найден experiments/questions.json.');
              experiment.evaluation.questionIds = chooseQuestionIds(questions, experiment.evaluation.randomQuestions);
            }
            experiment.evaluation.variants = [{ name: 'menu' }];
            experiment.evaluation.variantNames = ['menu'];
            console.log(`Вопросы: ${JSON.stringify(experiment.evaluation.questionIds)}`);
            if ((await input.question('Запустить? (да/нет): ')).trim().toLowerCase() === 'да') await actions.evaluate(experiment);
            break;
          }
          case 5: settings = structuredClone(base); console.log('Выбор сброшен.'); break;
          default: console.log('Выберите номер из списка.');
        }
      } catch (error) { console.error(`Ошибка: ${error.message}${error.cause ? ` (${error.cause.message})` : ''}`); }
    }
  } finally { input.close(); }
}
