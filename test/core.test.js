import test from 'node:test';
import assert from 'node:assert/strict';
import { makeChunks, normalizeUrl, parseHtml } from '../src/processing.js';
import { inScope } from '../src/grabber.js';
import { retrievalMetrics } from '../src/evaluation.js';
import { generate } from '../src/generation.js';
import config from '../src/config.js';
import { chooseQuestionIds, runMenu, applyPreset } from '../src/menu.js';
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
  assert.deepEqual(retrievalMetrics([{ payload: { url: 'x' } }, { payload: { url: 'y' } }], ['y']), { precisionAtK: 0.5, recallAtK: 1, hit: 1, reciprocalRank: 0.5 });
  assert.deepEqual(retrievalMetrics([{ payload: { url: 'y' } }, { payload: { url: 'y' } }], ['y', 'z'], 5), { precisionAtK: 0.4, recallAtK: 0.5, hit: 1, reciprocalRank: 1 });
  assert.deepEqual(retrievalMetrics([], ['y'], 5), { precisionAtK: 0, recallAtK: 0, hit: 0, reciprocalRank: 0 });
  assert.equal(retrievalMetrics([], [], 5), null);
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

test('menu combines presets, passes them to all actions and leaves config unchanged', async t => {
  t.mock.method(console, 'log', () => {});
  const errors = [];
  t.mock.method(console, 'error', message => errors.push(message));
  const original = structuredClone(config);
  const configFile = new URL('../src/config.js', import.meta.url);
  const before = await readFile(configFile, 'utf8');
  const answers = ['1', '2', '2', '3', '3', '2', '1', '6', '5', '2', '9', 'test question', '10', 'да', '11', '8', '0'];
  const calls = [];
  const input = {
    async question() { assert.ok(answers.length, 'Unexpected extra prompt'); return answers.shift(); },
    close() {}
  };
  await runMenu(config, {
    async index(settings) {
      calls.push({ action: 'index', settings: structuredClone(settings) });
      if (calls.length === 1) assert.deepEqual(makeChunks({ id: 'test', text: 'x'.repeat(2500) }, settings).map(chunk => chunk.start), [0, 900, 1800]);
    },
    async ask(question, settings) { calls.push({ action: 'ask', question, settings: structuredClone(settings) }); },
    async evaluate(settings) { calls.push({ action: 'evaluate', settings: structuredClone(settings) }); }
  }, input);
  assert.deepEqual(errors, []);
  assert.deepEqual(calls.map(call => call.action), ['index', 'ask', 'evaluate', 'index']);
  for (const call of calls.slice(0, 3)) {
    assert.equal(call.settings.chunkStrategy, 'overlap');
    assert.equal(call.settings.chunkSize, 1200);
    assert.equal(call.settings.chunkOverlap, 300);
    assert.equal(call.settings.topK, 8);
    assert.equal(call.settings.rerankerEnabled, false);
    assert.equal(call.settings.promptVariant, 'concise');
  }
  assert.equal(calls[2].settings.evaluation.questionIds.length, 12);
  assert.deepEqual(calls[2].settings.evaluation.variants, [{ name: 'menu' }]);
  assert.deepEqual(calls[3].settings, original);
  assert.deepEqual(config, original);
  assert.equal(await readFile(configFile, 'utf8'), before);
});

test('Qwen request uses the selected full or short prompt', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ answered: true, answer: 'Example', sourceIds: [1] }) } }));
  });
  const group = config.menuGroups.find(item => item.fields.includes('promptVariant'));
  const hits = [{ payload: { title: 'Example', text: 'Example context', url: 'https://example.com/' } }];
  const short = applyPreset(config, config, group, 'prompt-concise');
  const full = applyPreset(short, config, group, 'prompt-strict');
  await generate('Example?', hits, short);
  await generate('Example?', hits, full);
  assert.equal(requests[0].messages[0].content, config.prompts.concise);
  assert.equal(requests[1].messages[0].content, config.prompts.strict);
  assert.ok(requests[0].messages[0].content.length < requests[1].messages[0].content.length);
  assert.equal(requests[0].model, config.generationModel);
});
