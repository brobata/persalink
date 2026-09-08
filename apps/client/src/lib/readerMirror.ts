/**
 * @file Reader mirror — OS-native text selection over the terminal
 * @description xterm.js paints the terminal on a canvas, so there is no text
 *   in the DOM for Android's long-press selection to grab. This builds one: a
 *   real DOM copy of the buffer (one block per buffer row, colour runs as
 *   spans) laid over the canvas, so the OS's own selection — handles,
 *   Copy / Share / Select all — works exactly like on a web page or a PDF.
 *   Nothing is contenteditable: you can select and copy, never move or edit.
 *
 *   Lifecycle
 *   - `arm()`   on a touch that holds still: rows around the viewport, fully
 *               transparent (opacity 0) — a hit target for the OS long-press
 *               that is about to fire on the same touch.
 *   - `reveal()` once a selection lands inside it: opaque, the whole buffer
 *               filled in, scrolls natively. A FROZEN snapshot — output keeps
 *               flowing to the canvas underneath and is back on dismiss.
 *   - `dispose()` when the selection collapses (tap, Copy), the touch turned
 *               into a scroll, or the grid resized.
 *
 *   Copy is rewritten from the snapshot rows so soft-wrapped rows join back
 *   into one line (a wrapped path or URL pastes unbroken) and trailing pad
 *   spaces are trimmed — the two things a per-row DOM would get wrong.
 */
import type { IBufferCell, ITheme, Terminal } from '@xterm/xterm';

export interface ReaderFont {
  family: string;
  size: number;
  weight: string;
}

/** Rows built above/below the viewport while armed; the rest arrives on reveal. */
const ARM_PAD_ROWS = 150;

function palette256(theme: ITheme): string[] {
  const p: string[] = [
    theme.black ?? '#000000', theme.red ?? '#cd0000', theme.green ?? '#00cd00',
    theme.yellow ?? '#cdcd00', theme.blue ?? '#0000ee', theme.magenta ?? '#cd00cd',
    theme.cyan ?? '#00cdcd', theme.white ?? '#e5e5e5',
    theme.brightBlack ?? '#7f7f7f', theme.brightRed ?? '#ff0000', theme.brightGreen ?? '#00ff00',
    theme.brightYellow ?? '#ffff00', theme.brightBlue ?? '#5c5cff', theme.brightMagenta ?? '#ff00ff',
    theme.brightCyan ?? '#00ffff', theme.brightWhite ?? '#ffffff',
  ];
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
    p.push(`rgb(${steps[r]},${steps[g]},${steps[b]})`);
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    p.push(`rgb(${v},${v},${v})`);
  }
  return p;
}

const rgbOf = (v: number) => `rgb(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255})`;

export class ReaderMirror {
  private el: HTMLDivElement | null = null;
  private rowsEl: HTMLDivElement | null = null;
  private spacer: HTMLDivElement | null = null;
  private built: { from: number; to: number } | null = null;
  private revealed = false;
  private cellW = 0;
  private cellH = 0;
  /** Snapshot text + wrap flag per buffer row — copy never reads the live buffer. */
  private rowText = new Map<number, string>();
  private rowWrapped = new Map<number, boolean>();
  private palette: string[] = [];
  private theme: ITheme = {};
  private cell: IBufferCell | null = null;

  constructor(private term: Terminal, private host: HTMLElement) {}

  get active(): boolean { return this.el !== null; }
  get isRevealed(): boolean { return this.revealed; }
  contains(node: Node | null | undefined): boolean {
    return !!node && !!this.el && this.el.contains(node);
  }
  /** Does the document selection touch the mirror? Intersection, not
   *  containment — the OS's "Select all" selects the whole page. */
  hasSelection(): boolean {
    const sel = document.getSelection();
    if (!this.el || !sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    return sel.containsNode(this.el, true);
  }
  /** Pull a selection that spills outside the mirror (Select all) back onto
   *  the terminal rows, so the highlight and handles stay on the text and
   *  nothing of the app chrome is "selected". True when it changed. */
  clampSelection(): boolean {
    const sel = document.getSelection();
    if (!this.rowsEl || !sel || sel.rangeCount === 0 || sel.isCollapsed || !this.hasSelection()) return false;
    const r = sel.getRangeAt(0);
    if (this.rowsEl.contains(r.startContainer) && this.rowsEl.contains(r.endContainer)) return false;
    const m = this.clampedRange(r);
    sel.removeAllRanges();
    sel.addRange(m);
    return true;
  }
  /** `r` intersected with the mirror rows. */
  private clampedRange(r: Range): Range {
    const m = document.createRange();
    m.selectNodeContents(this.rowsEl!);
    if (r.compareBoundaryPoints(Range.START_TO_START, m) > 0) m.setStart(r.startContainer, r.startOffset);
    if (r.compareBoundaryPoints(Range.END_TO_END, m) < 0) m.setEnd(r.endContainer, r.endOffset);
    return m;
  }
  /** Is a client point over the terminal grid (not padding / chrome)? */
  overGrid(clientX: number, clientY: number): boolean {
    const screen = this.host.querySelector('.xterm-screen');
    if (!screen) return false;
    const r = screen.getBoundingClientRect();
    return clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom;
  }

  /** Build the transparent hit target. False when the grid isn't measurable. */
  arm(): boolean {
    if (this.el) return true;
    const screen = this.host.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen) return false;
    const sr = screen.getBoundingClientRect();
    const hr = this.host.getBoundingClientRect();
    if (sr.width === 0 || sr.height === 0) return false;
    const term = this.term;
    this.cellW = sr.width / term.cols;
    this.cellH = sr.height / term.rows;
    this.theme = term.options.theme ?? {};
    this.palette = palette256(this.theme);
    this.cell = term.buffer.active.getNullCell();
    this.rowText.clear();
    this.rowWrapped.clear();

    const font: ReaderFont = {
      family: term.options.fontFamily ?? 'monospace',
      size: term.options.fontSize ?? 14,
      weight: String(term.options.fontWeight ?? '400'),
    };
    // Match the canvas advance: xterm sizes cells from the same font, so the
    // DOM glyph only differs by sub-pixel rounding — letter-spacing closes it.
    let advance = this.cellW;
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      if (ctx) {
        ctx.font = `${font.weight} ${font.size}px ${font.family}`;
        advance = ctx.measureText('W').width || this.cellW;
      }
    } catch { /* no 2d context — cell width is close enough */ }

    const el = document.createElement('div');
    el.className = 'pl-reader';
    el.style.cssText = [
      'position:absolute', 'inset:0', 'z-index:20', 'box-sizing:border-box',
      'overflow:hidden', 'opacity:0', 'touch-action:none',
      'user-select:text', '-webkit-user-select:text', 'cursor:text',
      `background:${this.theme.background ?? '#000'}`,
      `color:${this.theme.foreground ?? '#fff'}`,
      `font-family:${font.family}`, `font-size:${font.size}px`, `font-weight:${font.weight}`,
      `letter-spacing:${(this.cellW - advance).toFixed(3)}px`,
      'font-variant-ligatures:none', 'white-space:pre',
      `padding-left:${sr.left - hr.left}px`, `padding-top:${sr.top - hr.top}px`,
      `padding-bottom:${Math.max(0, hr.bottom - sr.bottom)}px`,
    ].join(';');
    // Overscroll must not bounce the page/PWA shell behind us.
    el.style.overscrollBehavior = 'contain';

    const buf = term.buffer.active;
    const from = Math.max(0, buf.viewportY - ARM_PAD_ROWS);
    const to = Math.min(buf.length, buf.viewportY + term.rows + ARM_PAD_ROWS);
    // Rows before `from` are a spacer until reveal, so row r always sits at
    // y = r * cellH inside the scroller and scrollTop maps 1:1 to viewportY.
    const spacer = document.createElement('div');
    spacer.style.height = `${from * this.cellH}px`;
    const rowsEl = document.createElement('div');
    for (let r = from; r < to; r++) rowsEl.appendChild(this.buildRow(r));
    el.appendChild(spacer);
    el.appendChild(rowsEl);
    // Document-level: a Select-all copy fires on <body>, not on the mirror.
    document.addEventListener('copy', this.onCopy, true);
    this.host.appendChild(el);
    el.scrollTop = buf.viewportY * this.cellH;

    this.el = el;
    this.rowsEl = rowsEl;
    this.spacer = spacer;
    this.built = { from, to };
    this.revealed = false;
    return true;
  }

  /** Make the snapshot visible, complete and natively scrollable. */
  reveal(): void {
    if (!this.el || !this.rowsEl || !this.spacer || !this.built || this.revealed) return;
    const buf = this.term.buffer.active;
    const { from, to } = this.built;
    // Siblings only — inserting around the selected nodes leaves the live
    // Range untouched. Total height is unchanged, so nothing jumps.
    if (from > 0) {
      const frag = document.createDocumentFragment();
      for (let r = 0; r < from; r++) frag.appendChild(this.buildRow(r));
      this.rowsEl.insertBefore(frag, this.rowsEl.firstChild);
      this.spacer.style.height = '0px';
    }
    if (to < buf.length) {
      const frag = document.createDocumentFragment();
      for (let r = to; r < buf.length; r++) frag.appendChild(this.buildRow(r));
      this.rowsEl.appendChild(frag);
    }
    this.built = { from: 0, to: buf.length };
    this.el.style.opacity = '1';
    this.el.style.overflowY = 'auto';
    this.el.style.touchAction = 'pan-y';
    this.revealed = true;
  }

  /** Arm + reveal with no selection — the toolbar entry. */
  open(): boolean {
    if (!this.arm()) return false;
    this.reveal();
    return true;
  }

  dispose(): void {
    if (!this.el) return;
    document.removeEventListener('copy', this.onCopy, true);
    this.el.remove();
    this.el = null;
    this.rowsEl = null;
    this.spacer = null;
    this.built = null;
    this.revealed = false;
    this.rowText.clear();
    this.rowWrapped.clear();
    const sel = document.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      // A selection that lived in the removed nodes would otherwise linger
      // as a phantom range and keep Android's toolbar up.
      try { sel.removeAllRanges(); } catch { /* nothing to clear */ }
    }
  }

  /** The current selection as terminal text, or null when it isn't ours. */
  selectionText(): string | null {
    const sel = document.getSelection();
    if (!this.el || !this.rowsEl || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    if (!this.hasSelection()) return null;
    const range = this.clampedRange(sel.getRangeAt(0));
    const a = this.resolve(range.startContainer, range.startOffset, 'start');
    const b = this.resolve(range.endContainer, range.endOffset, 'end');
    if (!a || !b) return null;
    let out = '';
    for (let r = a.row; r <= b.row; r++) {
      const t = this.rowText.get(r) ?? '';
      const piece = t.slice(r === a.row ? a.col : 0, r === b.row ? b.col : t.length);
      const joinsNext = r < b.row && this.rowWrapped.get(r + 1) === true;
      if (joinsNext) out += piece;
      else {
        out += piece.replace(/\s+$/, '');
        if (r < b.row) out += '\n';
      }
    }
    return out;
  }

  private onCopy = (e: ClipboardEvent) => {
    const text = this.selectionText();
    if (text === null || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  };

  private buildRow(r: number): HTMLDivElement {
    const div = document.createElement('div');
    div.dataset.row = String(r);
    div.style.height = `${this.cellH}px`;
    div.style.lineHeight = `${this.cellH}px`;
    const line = this.term.buffer.active.getLine(r);
    const cell = this.cell;
    if (!line || !cell) {
      this.rowText.set(r, '');
      this.rowWrapped.set(r, false);
      return div;
    }
    this.rowWrapped.set(r, line.isWrapped);
    let text = '';
    let runStyle = '';
    let runText = '';
    const flush = () => {
      if (!runText) return;
      if (runStyle) {
        const s = document.createElement('span');
        s.style.cssText = runStyle;
        s.textContent = runText;
        div.appendChild(s);
      } else {
        div.appendChild(document.createTextNode(runText));
      }
      runText = '';
    };
    for (let x = 0; x < line.length; x++) {
      line.getCell(x, cell);
      const w = cell.getWidth();
      if (w === 0) continue; // trailing half of a wide glyph
      const ch = cell.getChars() || ' ';
      const st = this.styleFor(cell);
      if (w === 2) {
        // A wide glyph takes two cells on the canvas; pin its box so the
        // rest of the row stays aligned with what the finger sees.
        flush();
        const s = document.createElement('span');
        s.style.cssText = `${st}display:inline-block;width:${this.cellW * 2}px;letter-spacing:0;`;
        s.textContent = ch;
        div.appendChild(s);
        text += ch;
        continue;
      }
      if (st !== runStyle) {
        flush();
        runStyle = st;
      }
      runText += ch;
      text += ch;
    }
    flush();
    this.rowText.set(r, text);
    return div;
  }

  private styleFor(cell: IBufferCell): string {
    const bold = cell.isBold() !== 0;
    let fg: string | null = null;
    let bg: string | null = null;
    if (cell.isFgPalette()) {
      let idx = cell.getFgColor();
      if (bold && idx < 8) idx += 8; // xterm draws bold text in bright colours
      fg = this.palette[idx] ?? null;
    } else if (cell.isFgRGB()) {
      fg = rgbOf(cell.getFgColor());
    }
    if (cell.isBgPalette()) bg = this.palette[cell.getBgColor()] ?? null;
    else if (cell.isBgRGB()) bg = rgbOf(cell.getBgColor());
    if (cell.isInverse() !== 0) {
      const nfg = bg ?? this.theme.background ?? '#000';
      const nbg = fg ?? this.theme.foreground ?? '#fff';
      fg = nfg;
      bg = nbg;
    }
    let s = '';
    if (fg) s += `color:${fg};`;
    if (bg) s += `background:${bg};`;
    if (bold) s += 'font-weight:700;';
    if (cell.isDim() !== 0) s += 'opacity:.55;';
    if (cell.isItalic() !== 0) s += 'font-style:italic;';
    if (cell.isUnderline() !== 0) s += 'text-decoration:underline;';
    if (cell.isInvisible() !== 0) s += 'color:transparent;';
    return s;
  }

  /** Map a Range boundary to a snapshot (row, string col). */
  private resolve(node: Node, offset: number, side: 'start' | 'end'): { row: number; col: number } | null {
    if (!this.el) return null;
    let textNode: Text | null = null;
    let textOffset = 0;
    if (node.nodeType === Node.TEXT_NODE) {
      textNode = node as Text;
      textOffset = offset;
    } else {
      // Element boundary (row div, rows container, or the mirror itself for
      // "Select all"): the first text at/after the child at `offset`, or
      // the last text before the end of the element.
      const el = node as Element;
      const child = el.childNodes[offset] ?? null;
      const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
      if (child) {
        walker.currentNode = child;
        textNode = child.nodeType === Node.TEXT_NODE ? (child as Text) : (walker.nextNode() as Text | null);
        textOffset = 0;
      } else {
        walker.currentNode = el;
        let last: Text | null = null;
        let t = walker.nextNode() as Text | null;
        while (t && el.contains(t)) { last = t; t = walker.nextNode() as Text | null; }
        if (!last) {
          walker.currentNode = el;
          last = walker.previousNode() as Text | null;
        }
        textNode = last;
        textOffset = last ? last.length : 0;
      }
      if (!textNode) {
        // No text on that side (empty row): fall back to the row's edge.
        const rowEl = (child ?? el).parentElement?.closest('[data-row]') ?? (child as Element | null)?.closest?.('[data-row]');
        if (!rowEl) return null;
        const row = Number((rowEl as HTMLElement).dataset.row);
        return { row, col: side === 'start' ? 0 : (this.rowText.get(row) ?? '').length };
      }
    }
    const rowEl = textNode.parentElement?.closest('[data-row]') as HTMLElement | null;
    if (!rowEl) return null;
    const row = Number(rowEl.dataset.row);
    let col = textOffset;
    const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT);
    let t = walker.nextNode() as Text | null;
    while (t && t !== textNode) { col += t.length; t = walker.nextNode() as Text | null; }
    return { row, col };
  }
}
