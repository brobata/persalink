/**
 * @file Snippet Manager
 * @description Global command library stored in ~/.persalink/snippets.json.
 *   Snippets are server-wide (unlike per-profile quick actions) — the raw
 *   {{variable}} templates are stored verbatim; variable prompting happens
 *   client-side at run time.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Snippet } from '@persalink/shared/protocol';
import { SnippetSchema } from '@persalink/shared/protocol';
import { atomicWriteFileSync } from './atomicWrite';
import { CONFIG_DIR } from './config';

const SNIPPETS_FILE = path.join(CONFIG_DIR, 'snippets.json');

export class SnippetManager {
  private snippets: Snippet[] = [];

  load(): void {
    try {
      if (!fs.existsSync(SNIPPETS_FILE)) return;
      const parsed: unknown = JSON.parse(fs.readFileSync(SNIPPETS_FILE, 'utf-8'));
      if (!Array.isArray(parsed)) return;
      this.snippets = parsed.filter((s) => SnippetSchema.safeParse(s).success) as Snippet[];
    } catch (err) {
      console.warn('[PersaLink] Could not load snippets:', err instanceof Error ? err.message : err);
    }
  }

  private persist(): void {
    atomicWriteFileSync(SNIPPETS_FILE, JSON.stringify(this.snippets, null, 2));
  }

  list(): Snippet[] {
    return this.snippets;
  }

  save(snippet: Snippet): void {
    const idx = this.snippets.findIndex((s) => s.id === snippet.id);
    if (idx >= 0) this.snippets[idx] = snippet;
    else this.snippets.push(snippet);
    this.persist();
  }

  delete(id: string): void {
    const before = this.snippets.length;
    this.snippets = this.snippets.filter((s) => s.id !== id);
    if (this.snippets.length !== before) this.persist();
  }
}
