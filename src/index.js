import config from './config.js';
import { grab } from './grabber.js';
import { indexDocuments } from './database.js';
import { retrieve } from './retrieval.js';
import { generate } from './generation.js';
import { evaluate } from './evaluation.js';
import { createInterface } from 'node:readline/promises';

try {
  switch (process.argv[2]) {
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
      const result = await generate(question, await retrieve(question, config), config);
      console.log(`\n${result.answer}`);
      for (const source of result.sources) console.log(`Источник: ${source.title}\n${source.url}`);
      break;
    }
    default: throw new Error('Команды: grab | index | ask | evaluate');
  }
} catch (error) { console.error(`Ошибка: ${error.message}${error.cause ? ` (${error.cause.message})` : ''}`); process.exitCode = 1; }
