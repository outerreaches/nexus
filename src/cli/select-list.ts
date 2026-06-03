import type { SharedTui } from "./tui.js";

/**
 * A reusable raw-mode list picker for the interactive CLI. Lets the operator
 * scroll a list with ↑/↓, narrow it by typing a filter, and pick with Enter
 * (Esc / Ctrl+C cancels). Used by `/model` and `/provider` so long model
 * catalogues don't have to be typed out by hand.
 *
 * The pure helpers (filter / window / clamp) are split out and unit-tested; the
 * `promptListSelection` loop owns only the terminal I/O.
 */

export type SelectItem = {
  /** Returned to the caller when chosen. */
  value: string;
  /** Display text; falls back to `value`. */
  label?: string;
  /** Dim suffix shown after the label (e.g. "current", "configured"). */
  hint?: string;
};

export type SelectListOptions = {
  title: string;
  items: SelectItem[];
  tui: SharedTui;
  /** When set, the matching item starts highlighted and is tagged "current". */
  currentValue?: string;
  /** Visible rows in the scrolling window. Default 10. */
  pageSize?: number;
  /** Footer hint line; a sensible default is used when omitted. */
  footer?: string;
  /** Streams overridable for testing. Default process.stdin/stdout. */
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
};

const DEFAULT_PAGE_SIZE = 10;

const ESC = 0x1b;
const CTRL_C = 0x03;
const CTRL_U = 0x15;
const BACKSPACE = 0x7f;
const CTRL_H = 0x08;

/** Substring filter: every whitespace-separated term must appear in label+value. */
export function filterSelectItems(items: SelectItem[], query: string): SelectItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const terms = q.split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    const hay = `${item.label ?? item.value} ${item.value}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(length - 1, Math.floor(index)));
}

/** Compute the visible [start, end) slice that keeps `active` roughly centred. */
export function computeWindow(params: { total: number; active: number; pageSize: number }): {
  start: number;
  end: number;
} {
  const total = Math.max(0, Math.floor(params.total));
  const pageSize = Math.max(1, Math.floor(params.pageSize));
  if (total <= pageSize) return { start: 0, end: total };
  const active = clampIndex(params.active, total);
  let start = active - Math.floor(pageSize / 2);
  start = Math.max(0, Math.min(start, total - pageSize));
  return { start, end: start + pageSize };
}

function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(0, max));
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Render the picker and resolve with the chosen value, or null if cancelled or
 * if the terminal isn't an interactive TTY (caller should fall back).
 */
export async function promptListSelection(opts: SelectListOptions): Promise<string | null> {
  const stdin = opts.input ?? process.stdin;
  const stdout = opts.output ?? process.stdout;
  const tui = opts.tui;
  const pageSize = Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE);
  const footer = opts.footer ?? "↑/↓ move · type to filter · Enter select · Esc cancel";

  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    return null;
  }

  const { clearScreenDown, cursorTo, moveCursor } = await import("node:readline");
  const previousRawMode = stdin.isRaw;

  // Tag the current value and seed the highlight on it.
  let initialActive = 0;
  const items = opts.items.map((item, idx) => {
    if (opts.currentValue !== undefined && item.value === opts.currentValue) {
      initialActive = idx;
      const hint = item.hint ? `${item.hint}, current` : "current";
      return { ...item, hint };
    }
    return item;
  });

  return await new Promise<string | null>((resolve, reject) => {
    let query = "";
    let active = initialActive;
    let renderedRows = 0;
    let escaped = false;
    let inCsi = false;
    let csiBuf = "";
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      stdin.off("data", onData);
      if (!previousRawMode) stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\x1b[?25h"); // restore cursor
    };

    const clearRender = () => {
      if (renderedRows > 0) {
        if (renderedRows > 1) moveCursor(stdout, 0, -(renderedRows - 1));
        cursorTo(stdout, 0);
        clearScreenDown(stdout);
        renderedRows = 0;
      }
    };

    const done = (result: string | null) => {
      clearRender();
      cleanup();
      resolve(result);
    };

    const fail = (err: unknown) => {
      clearRender();
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const render = () => {
      const columns = typeof stdout.columns === "number" ? stdout.columns : 80;
      const width = Math.max(20, columns - 1);
      const filtered = filterSelectItems(items, query);
      active = clampIndex(active, filtered.length);

      const lines: string[] = [];
      lines.push(tui.paint("prompt", truncate(`[ ${opts.title} ]`, width)));
      const filterLabel = query.length > 0 ? `filter: ${query}` : "filter: (type to narrow)";
      lines.push(tui.paint("dim", truncate(filterLabel, width)));

      if (filtered.length === 0) {
        lines.push(tui.paint("error", truncate("  (no matches)", width)));
      } else {
        const { start, end } = computeWindow({ total: filtered.length, active, pageSize });
        if (start > 0) lines.push(tui.paint("dim", `  ↑ ${start} more`));
        for (let i = start; i < end; i++) {
          const item = filtered[i]!;
          const base = item.label ?? item.value;
          const text = item.hint ? `${base}  (${item.hint})` : base;
          if (i === active) {
            lines.push(tui.paint("prompt", truncate(`› ${text}`, width)));
          } else {
            lines.push(tui.paint("assistant", truncate(`  ${text}`, width)));
          }
        }
        if (end < filtered.length) lines.push(tui.paint("dim", `  ↓ ${filtered.length - end} more`));
      }
      lines.push(tui.paint("dim", truncate(footer, width)));

      clearRender();
      stdout.write("\x1b[?25l"); // hide cursor while navigating
      stdout.write(lines.join("\n"));
      renderedRows = lines.length;
    };

    const moveActive = (delta: number) => {
      const filtered = filterSelectItems(items, query);
      if (filtered.length === 0) return;
      active = clampIndex(active + delta, filtered.length);
    };

    const submit = () => {
      const filtered = filterSelectItems(items, query);
      if (filtered.length === 0) return; // nothing to pick — ignore Enter
      const chosen = filtered[clampIndex(active, filtered.length)];
      done(chosen ? chosen.value : null);
    };

    const handleCsi = (seq: string): boolean => {
      switch (seq) {
        case "A": moveActive(-1); return true;
        case "B": moveActive(1); return true;
        case "H": active = 0; return true;
        case "F": active = Number.MAX_SAFE_INTEGER; return true;
        case "5~": moveActive(-pageSize); return true;
        case "6~": moveActive(pageSize); return true;
        default: return false;
      }
    };

    const onData = (chunk: Buffer | string) => {
      try {
        const input = chunk.toString("utf8");
        let dirty = false;
        for (const ch of input) {
          const code = ch.codePointAt(0) ?? 0;
          if (inCsi) {
            csiBuf += ch;
            if (code >= 0x40 && code <= 0x7e) {
              inCsi = false;
              if (handleCsi(csiBuf)) dirty = true;
              csiBuf = "";
            }
            continue;
          }
          if (escaped) {
            escaped = false;
            if (ch === "[") {
              inCsi = true;
              csiBuf = "";
              continue;
            }
            // Lone Esc (or Alt+key) → cancel.
            done(null);
            return;
          }
          if (code === ESC) { escaped = true; continue; }
          if (code === CTRL_C) { done(null); return; }
          if (ch === "\r" || ch === "\n") { submit(); return; }
          if (code === CTRL_U) { query = ""; active = 0; dirty = true; continue; }
          if (code === BACKSPACE || code === CTRL_H) {
            if (query.length > 0) { query = query.slice(0, -1); active = 0; dirty = true; }
            continue;
          }
          if (code >= 0x20 && code !== 0x7f) { query += ch; active = 0; dirty = true; }
        }
        // A lone ESC arrives as a single-byte chunk with nothing following it.
        if (escaped) { escaped = false; done(null); return; }
        if (dirty) render();
      } catch (err) {
        fail(err);
      }
    };

    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      render();
    } catch (err) {
      fail(err);
    }
  });
}
