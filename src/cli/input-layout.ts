function normalizeColumns(columns: number): number {
  if (!Number.isFinite(columns)) return 80;
  return Math.max(1, Math.floor(columns));
}

function normalizePromptLen(promptLen: number): number {
  if (!Number.isFinite(promptLen)) return 0;
  return Math.max(0, Math.floor(promptLen));
}

function clampCursorPos(cursorPos: number, max: number): number {
  if (!Number.isFinite(cursorPos)) return max;
  return Math.max(0, Math.min(max, Math.floor(cursorPos)));
}

function advanceCells(state: { row: number; col: number }, columns: number, cells: number): void {
  const total = state.col + Math.max(0, cells);
  state.row += Math.floor(total / columns);
  state.col = total % columns;
}

function advancePromptLine(state: { row: number; col: number }, columns: number, promptLen: number, lineLength: number): void {
  advanceCells(state, columns, promptLen + Math.max(0, lineLength));
}

function advanceNewline(state: { row: number; col: number }): void {
  state.row += 1;
  state.col = 0;
}

function resolveCursorLogicalPosition(value: string, cursorPos: number): { lineIndex: number; offset: number; lines: string[] } {
  const lines = value.split("\n");
  let remaining = clampCursorPos(cursorPos, value.length);
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i].length;
    if (remaining <= len) return { lineIndex: i, offset: remaining, lines };
    remaining -= len + 1;
  }
  const last = lines.length - 1;
  return { lineIndex: last, offset: lines[last].length, lines };
}

export function getPromptLayout(params: {
  value: string;
  cursorPos: number;
  promptLen: number;
  columns: number;
}): { totalRows: number; cursorRow: number; cursorCol: number } {
  const columns = normalizeColumns(params.columns);
  const promptLen = normalizePromptLen(params.promptLen);
  const { lineIndex, offset, lines } = resolveCursorLogicalPosition(params.value, params.cursorPos);

  const cursorState = { row: 0, col: 0 };
  for (let i = 0; i < lineIndex; i++) {
    advancePromptLine(cursorState, columns, promptLen, lines[i].length);
    advanceNewline(cursorState);
  }
  advancePromptLine(cursorState, columns, promptLen, offset);

  const totalState = { row: 0, col: 0 };
  for (let i = 0; i < lines.length; i++) {
    advancePromptLine(totalState, columns, promptLen, lines[i].length);
    if (i < lines.length - 1) advanceNewline(totalState);
  }
  const totalRows = totalState.row + 1;

  return {
    totalRows: Math.max(1, totalRows),
    cursorRow: Math.min(totalRows - 1, cursorState.row),
    cursorCol: cursorState.col,
  };
}

export function countWrappedPromptRows(params: { value: string; promptLen: number; columns: number }): number {
  const layout = getPromptLayout({
    value: params.value,
    cursorPos: params.value.length,
    promptLen: params.promptLen,
    columns: params.columns,
  });
  return layout.totalRows;
}
