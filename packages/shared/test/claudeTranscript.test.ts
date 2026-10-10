/**
 * @file Claude transcript parsing tests
 * @description Run with `npm test` (node --test, native TS type stripping).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscriptLines, lastReply, assistantTexts, extractCodeBlocks } from '../src/claudeTranscript.ts';

const user = (text: string, extra: object = {}) => JSON.stringify({ type: 'user', message: { content: text }, ...extra });
const toolResult = () => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
const said = (text: string, extra: object = {}) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra });
const thought = () => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } });

test('last reply = all assistant text since the last real prompt', () => {
  const jsonl = [
    user('first'), said('old answer'),
    user('second'), thought(), said('Part one.'), toolResult(), said('Part two.'),
    JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
  ].join('\n');
  assert.equal(lastReply(parseTranscriptLines(jsonl)), 'Part one.\n\nPart two.');
});

test('falls back to the previous reply while Claude has not written text yet', () => {
  const jsonl = [user('q1'), said('answer one'), user('q2'), thought()].join('\n');
  assert.equal(lastReply(parseTranscriptLines(jsonl)), 'answer one');
});

test('meta, sidechain and tool-result entries are not prompts or replies', () => {
  const jsonl = [
    user('real'), said('kept'),
    user('<hook output>', { isMeta: true }), toolResult(),
    said('subagent chatter', { isSidechain: true }),
  ].join('\n');
  assert.equal(lastReply(parseTranscriptLines(jsonl)), 'kept');
});

test('partial and corrupt lines are skipped', () => {
  const jsonl = '{"type":"assis\n' + said('fine') + '\nnot json\n';
  assert.equal(lastReply(parseTranscriptLines(jsonl)), 'fine');
});

test('assistantTexts joins every reply, oldest first', () => {
  const jsonl = [said('a https://a.com'), user('x'), said('b')].join('\n');
  assert.equal(assistantTexts(parseTranscriptLines(jsonl)), 'a https://a.com\n\nb');
});

test('extracts fenced code blocks, including indented and tilde fences', () => {
  const md = [
    'Run this:',
    '```bash',
    'claude mcp add x \\',
    '  --flag',
    '```',
    '1. Then:',
    '   ```json',
    '   { "a": 1 }',
    '   ```',
    '~~~',
    'plain',
    '~~~',
  ].join('\n');
  assert.deepEqual(extractCodeBlocks(md), [
    { lang: 'bash', code: 'claude mcp add x \\\n  --flag' },
    { lang: 'json', code: '{ "a": 1 }' },
    { lang: '', code: 'plain' },
  ]);
});

test('a longer fence is not closed by a shorter one', () => {
  const md = '````md\n```js\nx\n```\n````';
  assert.deepEqual(extractCodeBlocks(md), [{ lang: 'md', code: '```js\nx\n```' }]);
});
