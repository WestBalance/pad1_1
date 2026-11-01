import test from 'node:test';
import assert from 'node:assert/strict';
import { makeChunks, normalizeUrl, parseHtml } from '../src/processing.js';
import { inScope } from '../src/grabber.js';
import { retrievalMetrics } from '../src/evaluation.js';
import { generate } from '../src/generation.js';
import config from '../src/config.js';
import { chooseQuestionIds } from '../src/menu.js';
import { readFile } from 'node:fs/promises';

test('chunking covers full text, preserves overlap and stable IDs', () => {
  const document = { id: 'a', text: '0123456789abcdef' };
  const settings = { ...config, chunkSize: 6, chunkOverlap: 2 };
  const chunks = makeChunks(document, settings);
  assert.deepEqual(chunks.map(c => c.text), ['012345', '456789', '89abcd', 'cdef']);
  assert.equal(chunks[0].id, makeChunks(document, settings)[0].id);
  assert.equal(makeChunks(document, { ...settings, chunkStrategy: 'fixed' }).map(c => c.text).join(''), document.text);
  assert.throws(() => makeChunks(document, { ...settings, chunkOverlap: 6 }));
});
test('generic HTML extraction and crawler boundaries', () => {
  const parsed = parseHtml('<title>Test</title><nav>Menu</nav><main><p>A &amp; B</p><script>evil</script><a href="page.html#x">Next</a></main>', config.sourceUrl);
  assert.equal(parsed.text, 'A & B Next');
  assert.equal(parsed.links[0], `${config.sourceUrl}page.html`);
  assert.equal(inScope('https://docs.python.org/3/library/os.html', config), false);
  assert.equal(normalizeUrl('javascript:alert(1)', config.sourceUrl), null);
});
test('metrics use first relevant rank and empty context never calls LLM', async () => {
  assert.deepEqual(retrievalMetrics([{ payload: { url: 'x' } }, { payload: { url: 'y' } }], ['y']), { hit: 1, reciprocalRank: 0.5 });
  assert.equal((await generate('question', [], config)).answered, false);
});

test('menu selects ten answerable and two unanswerable questions without duplicates', async () => {
  const questions = JSON.parse(await readFile(new URL('../experiments/questions.json', import.meta.url), 'utf8'));
  const ids = chooseQuestionIds(questions, config.evaluation.randomQuestions);
  assert.equal(ids.length, 12);
  assert.equal(new Set(ids).size, 12);
  assert.equal(questions.filter(q => ids.includes(q.id) && q.expectedUrls.length > 0).length, 10);
  assert.equal(questions.filter(q => ids.includes(q.id) && q.expectedUrls.length === 0).length, 2);
  assert.throws(() => chooseQuestionIds(questions, { answerableCount: 26, unanswerableCount: 2 }), /Недостаточно вопросов/);
});
