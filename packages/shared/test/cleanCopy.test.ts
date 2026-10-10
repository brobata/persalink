/**
 * @file cleanTerminalCopy tests
 * @description Run with `npm test` (node --test, native TS type stripping).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTerminalCopy } from '../src/cleanCopy.ts';

const COLS = 60;

test('rejoins a URL that the TUI broke at the wrap edge', () => {
  const url = 'https://github.com/brobata/persalink/blob/main/docs/plans/termius-parity-roadmap.md';
  const row1 = '  ' + url.slice(0, COLS - 2);
  const row2 = '  ' + url.slice(COLS - 2);
  assert.equal(cleanTerminalCopy(`${row1}\n${row2}`, COLS), url);
});

test('strips the shared gutter but keeps relative indentation', () => {
  const sel = [
    '  {',
    '    "mcpServers": {',
    '      "x": { "command": "npx" }',
    '    }',
    '  }',
  ].join('\n');
  assert.equal(
    cleanTerminalCopy(sel, COLS),
    '{\n  "mcpServers": {\n    "x": { "command": "npx" }\n  }\n}',
  );
});

test('a drag starting mid-row: first row has no gutter, the rest do', () => {
  const sel = '{\n    "a": 1,\n    "b": 2\n  }';
  assert.equal(cleanTerminalCopy(sel, COLS), '{\n  "a": 1,\n  "b": 2\n}');
});

test('does not glue prose lines or consecutive URLs', () => {
  const a = '  https://example.com/a/really/long/path/that/fills/the/row';
  const b = '  https://example.com/b';
  assert.equal(cleanTerminalCopy(`${a}\n${b}`, a.length), `${a.trim()}\n${b.trim()}`);
  const prose = '  This is an ordinary sentence that wraps at a word\n  boundary and continues here.';
  assert.equal(
    cleanTerminalCopy(prose, 52),
    'This is an ordinary sentence that wraps at a word\nboundary and continues here.',
  );
});

test('keeps CRLF line endings when the input used them', () => {
  assert.equal(cleanTerminalCopy('  a\r\n  b', COLS), 'a\r\nb');
});

test('single line is just trimmed', () => {
  assert.equal(cleanTerminalCopy('   hello  ', COLS), 'hello');
});

test('full-width rows that were NOT wrapped stay separate', () => {
  const cols = 120;
  const sel = [
    './apps/client/src/components/ClaudeReplyPanel.tsx',
    './apps/client/src/lib/installPrompt.ts',
  ].join('\n');
  assert.equal(cleanTerminalCopy(sel, cols), sel);
  const envs = `export A=${'a'.repeat(46)}\nexport B=${'b'.repeat(46)}`;
  assert.equal(cleanTerminalCopy(envs, cols), envs);
  const hashes = Array.from({ length: 3 }, (_, i) => String(i).repeat(40)).join('\n');
  assert.equal(cleanTerminalCopy(hashes, cols), hashes);
});

test('a long non-URL token broken at the pane edge is rejoined', () => {
  const token = 'x'.repeat(90);
  const sel = `  ${token.slice(0, 58)}\n  ${token.slice(58)}`;
  assert.equal(cleanTerminalCopy(sel, 60), token);
});
