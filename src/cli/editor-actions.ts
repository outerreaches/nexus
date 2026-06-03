/**
 * Pure helpers for the interactive prompt editor in `nexus chat`: word-wise
 * cursor motion / deletion, ANSI CSI classification (so modified arrow keys map
 * to word jumps), and Tab completion of slash commands and their arguments.
 *
 * Kept free of terminal I/O so the fiddly logic is unit-testable; the editor in
 * app.ts is the thin glue that reads keys and applies these transforms.
 */

const WS = /\s/;

/** Index of the start of the word at/before `pos` (Alt+b / Ctrl+Left). */
export function wordLeft(value: string, pos: number): number {
  let i = Math.max(0, Math.min(pos, value.length));
  while (i > 0 && WS.test(value[i - 1]!)) i--; // skip whitespace left of cursor
  while (i > 0 && !WS.test(value[i - 1]!)) i--; // skip the word itself
  return i;
}

/** Index just past the word at/after `pos` (Alt+f / Ctrl+Right). */
export function wordRight(value: string, pos: number): number {
  const n = value.length;
  let i = Math.max(0, Math.min(pos, n));
  while (i < n && WS.test(value[i]!)) i++; // skip whitespace right of cursor
  while (i < n && !WS.test(value[i]!)) i++; // skip the word itself
  return i;
}

/** Delete the word before the cursor (Ctrl+W / Alt+Backspace). */
export function deleteWordBefore(value: string, pos: number): { value: string; cursorPos: number } {
  const start = wordLeft(value, pos);
  return { value: value.slice(0, start) + value.slice(pos), cursorPos: start };
}

/** Delete the word after the cursor (Alt+d / Ctrl+Delete). */
export function deleteWordAfter(value: string, pos: number): { value: string; cursorPos: number } {
  const end = wordRight(value, pos);
  return { value: value.slice(0, pos) + value.slice(end), cursorPos: pos };
}

export type CsiAction =
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "word-left"
  | "word-right"
  | "delete"
  | "delete-word"
  | null;

/**
 * Map a CSI sequence (the bytes after `ESC[`) to an editor action. Plain arrows
 * are A/B/C/D; modified arrows carry a `1;<mod>` parameter (3=Alt, 5=Ctrl, etc.)
 * which we treat as word motion. `~`-terminated sequences cover Home/End/Delete
 * and their modified word-delete variants.
 */
export function classifyCsi(seq: string): CsiAction {
  switch (seq) {
    case "A": return "up";
    case "B": return "down";
    case "C": return "right";
    case "D": return "left";
    case "H":
    case "1~":
    case "7~": return "home";
    case "F":
    case "4~":
    case "8~": return "end";
    case "3~": return "delete";
    default: break;
  }
  // Modified forms: ESC[1;<mod><final> for arrows/home/end, ESC[3;<mod>~ for delete.
  const mod = seq.match(/^1;\d+([A-H])$/);
  if (mod) {
    switch (mod[1]) {
      case "C": return "word-right";
      case "D": return "word-left";
      case "H": return "home";
      case "F": return "end";
      default: return null;
    }
  }
  if (/^3;\d+~$/.test(seq)) return "delete-word";
  return null;
}

export function longestCommonPrefix(items: string[]): string {
  if (items.length === 0) return "";
  let prefix = items[0]!;
  for (const item of items.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < item.length && prefix[i] === item[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

export type CompletionContext = {
  commands: string[];
  presets: string[];
  themes: string[];
  providers: string[];
};

export type CompletionResult = {
  /** Span in `value` to replace. */
  start: number;
  end: number;
  /** Full-token candidates that match the current prefix. */
  candidates: string[];
};

const FLAGS = ["--preset", "--tool", "--reset"];

/**
 * Determine the completion candidates for the token under the cursor. Returns
 * null when completion doesn't apply (e.g. typing a plain chat message).
 */
export function getCompletions(
  value: string,
  cursorPos: number,
  ctx: CompletionContext,
): CompletionResult | null {
  const pos = Math.max(0, Math.min(cursorPos, value.length));
  const before = value.slice(0, pos);
  // The active token is the run of non-whitespace immediately before the cursor.
  const tokenStart = before.length - (before.match(/\S*$/)?.[0].length ?? 0);
  const token = value.slice(tokenStart, pos);

  // Which argument slot is the cursor in? Count complete tokens before it.
  const priorTokens = before.slice(0, tokenStart).split(/\s+/).filter(Boolean);
  const slot = priorTokens.length; // 0 = command word, 1 = first arg, ...

  const make = (all: string[]): CompletionResult | null => {
    const lower = token.toLowerCase();
    const candidates = all.filter((c) => c.toLowerCase().startsWith(lower));
    if (candidates.length === 0) return null;
    return { start: tokenStart, end: pos, candidates };
  };

  if (slot === 0) {
    // Only complete the command word when it actually looks like one.
    if (token.length === 0 || !token.startsWith("/")) return null;
    return make(ctx.commands);
  }

  const command = normalizeCommand(priorTokens[0] ?? "");
  if (token.startsWith("--") && (command === "/model" || command === "/provider")) {
    return make(FLAGS);
  }
  if (slot === 1) {
    if (command === "/theme") return make(ctx.themes);
    if (command === "/presets") return make(ctx.presets);
    if (command === "/provider") return make([...ctx.providers, "orchestrator"]);
  }
  return null;
}

export type CompletionCycle = {
  candidates: string[];
  index: number;
  start: number;
  end: number;
};

export type CompletionPlan = {
  value: string;
  cursorPos: number;
  cycle: CompletionCycle | null;
};

/**
 * Decide what a Tab press does given the current input and any in-progress
 * cycle. Single match → complete + trailing space. Multiple → grow to the common
 * prefix first, then cycle through matches on subsequent presses. Returns null
 * when nothing can be completed (caller leaves the buffer untouched).
 */
export function planCompletion(
  value: string,
  cursorPos: number,
  ctx: CompletionContext,
  cycle: CompletionCycle | null,
): CompletionPlan | null {
  // Continue an active cycle: cursor still parked at the end of the last insert.
  if (
    cycle &&
    cursorPos === cycle.end &&
    value.slice(cycle.start, cycle.end) === cycle.candidates[cycle.index]
  ) {
    const index = (cycle.index + 1) % cycle.candidates.length;
    const token = cycle.candidates[index]!;
    const end = cycle.start + token.length;
    return {
      value: value.slice(0, cycle.start) + token + value.slice(cycle.end),
      cursorPos: end,
      cycle: { ...cycle, index, end },
    };
  }

  const res = getCompletions(value, cursorPos, ctx);
  if (!res || res.candidates.length === 0) return null;
  const token = value.slice(res.start, res.end);

  if (res.candidates.length === 1) {
    const replacement = `${res.candidates[0]} `;
    return {
      value: value.slice(0, res.start) + replacement + value.slice(res.end),
      cursorPos: res.start + replacement.length,
      cycle: null,
    };
  }

  const lcp = longestCommonPrefix(res.candidates);
  if (lcp.length > token.length) {
    return {
      value: value.slice(0, res.start) + lcp + value.slice(res.end),
      cursorPos: res.start + lcp.length,
      cycle: null,
    };
  }

  // Already at the common prefix → start cycling from the first candidate.
  const first = res.candidates[0]!;
  const end = res.start + first.length;
  return {
    value: value.slice(0, res.start) + first + value.slice(res.end),
    cursorPos: end,
    cycle: { candidates: res.candidates, index: 0, start: res.start, end },
  };
}

/** Strip a `/cmd@bot`-style suffix and lowercase, matching control parsers. */
function normalizeCommand(token: string): string {
  const lower = token.toLowerCase();
  const at = lower.indexOf("@");
  return at > 0 ? lower.slice(0, at) : lower;
}
