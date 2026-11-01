import config from './config.js';
import { grab } from './grabber.js';
import { indexDocuments } from './database.js';
import { retrieve } from './retrieval.js';
import { generate } from './generation.js';
import { evaluate } from './evaluation.js';
import { createInterface } from 'node:readline/promises';
import { runMenu } from './menu.js';

async function ask(question, settings) {
  const result = await generate(question, await retrieve(question, settings), settings);
  console.log(`\n${result.answer}`);
  for (const source of result.sources) console.log(`Источник: ${source.title}\n${source.url}`);
}

try {
  switch (process.argv[2]) {
    case undefined:
    case 'menu': await runMenu(config, { grab, index: indexDocuments, ask, evaluate }); break;
    case 'grab': await grab(config); break;
    case 'index': console.log(await indexDocuments(config)); break;
    case 'evaluate': await evaluate(config); break;
    case 'ask': {
      let question = process.argv.slice(3).join(' ').trim();
      if (!question) {
        const input = createInterface({ input: process.stdin, output: process.stdout });
        try { question = (await input.question('Ваш вопрос: ')).trim(); } finally { input.close(); }
      }
      if (!question) throw new Error('Введите вопрос.');
      await ask(question, config);
      break;
    }
    default: throw new Error('Команды: menu | grab | index | ask | evaluate');
  }
} catch (error) { console.error(`Ошибка: ${error.message}${error.cause ? ` (${error.cause.message})` : ''}`); process.exitCode = 1; }
