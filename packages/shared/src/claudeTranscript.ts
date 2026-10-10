/**
 * @file Claude Code transcript parsing
 * @description Pure helpers over Claude Code's session JSONL
 *   (~/.claude/projects/<slug>/<sessionId>.jsonl). The terminal only ever
 *   shows Claude's replies hard-wrapped to the pane width with a two-space
 *   gutter; the transcript holds the same replies as raw, unwrapped markdown.
 *   These helpers pull the last reply, its fenced code blocks, and the text
 *   of recent replies (for link harvesting) out of that file.
 *
 *   The JSONL format is internal to Claude Code and changes between versions,
 *   so everything here is defensive: unknown entry types and unparseable lines
 *   are skipped, never thrown on.
 */

export interface CodeBlock {
  lang: string;
  code: string;
}

interface TranscriptEntry {
  type?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown };
}

/** Parse JSONL text into entries, skipping blank and malformed lines (the
 *  first line of a tail read is usually a partial). */
export function parseTranscriptLines(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object') entries.push(parsed as TranscriptEntry);
    } catch { /* partial or corrupt line */ }
  }
  return entries;
}

function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') out.push(text);
    }
  }
  return out;
}

/** A prompt the user typed (or a slash command) — not a tool result, not a
 *  hook/meta injection, not subagent traffic. */
function isUserPrompt(e: TranscriptEntry): boolean {
  if (e.type !== 'user' || e.isMeta === true || e.isSidechain === true) return false;
  return textBlocks(e.message?.content).some((t) => t.trim().length > 0);
}

function assistantText(e: TranscriptEntry): string | null {
  if (e.type !== 'assistant' || e.isSidechain === true) return null;
  const text = textBlocks(e.message?.content).join('\n\n').trim();
  return text || null;
}

/**
 * The markdown of Claude's most recent reply: every assistant text block since
 * the last user prompt, in order. If Claude hasn't written any text yet for
 * the current prompt (still thinking / running tools), the previous reply is
 * returned instead. Null when the transcript has no assistant text at all.
 */
export function lastReply(entries: TranscriptEntry[]): string | null {
  let current: string[] = [];
  let previous: string[] = [];
  for (const e of entries) {
    if (isUserPrompt(e)) {
      if (current.length > 0) previous = current;
      current = [];
      continue;
    }
    const text = assistantText(e);
    if (text) current.push(text);
  }
  const reply = current.length > 0 ? current : previous;
  return reply.length > 0 ? reply.join('\n\n') : null;
}

/** All assistant text in the given entries, oldest first — raw material for
 *  link extraction (URLs here are never split by terminal wrapping). */
export function assistantTexts(entries: TranscriptEntry[]): string {
  const out: string[] = [];
  for (const e of entries) {
    const text = assistantText(e);
    if (text) out.push(text);
  }
  return out.join('\n\n');
}

/**
 * Fenced code blocks (``` or ~~~) in a markdown string, in order. Indented
 * fences (inside list items) are supported: the fence's indentation is
 * stripped from the block's lines. An unclosed fence runs to the end, the
 * way CommonMark renders it.
 */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = markdown.split('\n');
  let open: { char: string; len: number; indent: number; lang: string; body: string[] } | null = null;

  for (const line of lines) {
    if (!open) {
      const m = line.match(/^([ \t]*)(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/);
      if (m) open = { char: m[2][0], len: m[2].length, indent: m[1].length, lang: m[3] || '', body: [] };
      continue;
    }
    const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === open.char && close[1].length >= open.len) {
      blocks.push({ lang: open.lang, code: open.body.join('\n') });
      open = null;
      continue;
    }
    const indent = open.indent;
    open.body.push(line.replace(new RegExp(`^[ \\t]{0,${indent}}`), ''));
  }
  if (open && open.body.length > 0) blocks.push({ lang: open.lang, code: open.body.join('\n') });
  return blocks;
}
