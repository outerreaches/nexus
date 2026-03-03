import fs from "node:fs/promises";
import path from "node:path";

export type TerminalThemeId =
  | "terminal-green"
  | "terminal-amber"
  | "dos-bw"
  | "midnight-commander"
  | "light";

export type TerminalTheme = {
  id: TerminalThemeId;
  label: string;
  description: string;
  prompt: string;
  assistant: string;
  system: string;
  error: string;
  dim: string;
  reset: string;
};

const RESET = "\x1b[0m";

export const DEFAULT_TERMINAL_THEME: TerminalThemeId = "terminal-green";

const THEMES: Record<TerminalThemeId, TerminalTheme> = {
  "terminal-green": {
    id: "terminal-green",
    label: "Terminal Green",
    description: "Classic phosphor-green CRT vibe.",
    prompt: "\x1b[38;2;120;255;100m",
    assistant: "\x1b[38;2;57;255;20m",
    system: "\x1b[38;2;51;255;51;1m",
    error: "\x1b[38;2;255;51;51m",
    dim: "\x1b[38;2;17;170;17m",
    reset: RESET,
  },
  "terminal-amber": {
    id: "terminal-amber",
    label: "Terminal Amber",
    description: "Warm amber monitor style.",
    prompt: "\x1b[38;2;255;204;0m",
    assistant: "\x1b[38;2;255;176;0m",
    system: "\x1b[38;2;255;204;0;1m",
    error: "\x1b[38;2;255;51;51m",
    dim: "\x1b[38;2;170;102;0m",
    reset: RESET,
  },
  "dos-bw": {
    id: "dos-bw",
    label: "DOS B&W",
    description: "Low-color monochrome console.",
    prompt: "\x1b[97m",
    assistant: "\x1b[37m",
    system: "\x1b[97;1m",
    error: "\x1b[97;1m",
    dim: "\x1b[37;2m",
    reset: RESET,
  },
  "midnight-commander": {
    id: "midnight-commander",
    label: "Midnight Commander",
    description: "Blue-background retro file-manager style.",
    prompt: "\x1b[97;44m",
    assistant: "\x1b[37;44m",
    system: "\x1b[30;46m",
    error: "\x1b[37;41m",
    dim: "\x1b[36;44m",
    reset: RESET,
  },
  light: {
    id: "light",
    label: "Light",
    description: "High-contrast light-friendly palette.",
    prompt: "\x1b[30;47m",
    assistant: "\x1b[30m",
    system: "\x1b[30;1m",
    error: "\x1b[31;1m",
    dim: "\x1b[30;2m",
    reset: RESET,
  },
};

const THEME_ALIASES: Record<string, TerminalThemeId> = {
  green: "terminal-green",
  "terminal-green": "terminal-green",
  amber: "terminal-amber",
  "terminal-amber": "terminal-amber",
  dos: "dos-bw",
  bw: "dos-bw",
  mono: "dos-bw",
  "dos-bw": "dos-bw",
  midnight: "midnight-commander",
  mc: "midnight-commander",
  blue: "midnight-commander",
  "midnight-commander": "midnight-commander",
  light: "light",
};

type TerminalUiPreferences = {
  theme?: string;
};

const PREFS_FILE = "terminal-ui.json";

export function getTerminalTheme(themeId: TerminalThemeId): TerminalTheme {
  return THEMES[themeId];
}

export function listTerminalThemes(): TerminalTheme[] {
  return Object.values(THEMES);
}

export function resolveTerminalThemeId(raw: string): TerminalThemeId | null {
  const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return null;
  return THEME_ALIASES[normalized] ?? null;
}

export function paintTheme(theme: TerminalTheme, role: "prompt" | "assistant" | "system" | "error" | "dim", text: string, enabled = true): string {
  if (!enabled) return text;
  const color = theme[role];
  return `${color}${text}${theme.reset}`;
}

export function formatThemeList(current: TerminalThemeId): string {
  const lines: string[] = [];
  lines.push(`Current theme: ${current}`);
  lines.push("Available themes:");
  for (const theme of listTerminalThemes()) {
    const marker = theme.id === current ? "*" : " ";
    lines.push(` ${marker} ${theme.id} - ${theme.description}`);
  }
  lines.push("Usage: /theme <name>");
  return lines.join("\n");
}

export async function loadTerminalThemePreference(stateDir: string): Promise<TerminalThemeId> {
  const prefPath = path.join(stateDir, PREFS_FILE);
  try {
    const raw = await fs.readFile(prefPath, "utf8");
    const parsed = JSON.parse(raw) as TerminalUiPreferences;
    if (typeof parsed.theme !== "string") return DEFAULT_TERMINAL_THEME;
    return resolveTerminalThemeId(parsed.theme) ?? DEFAULT_TERMINAL_THEME;
  } catch {
    return DEFAULT_TERMINAL_THEME;
  }
}

export async function saveTerminalThemePreference(stateDir: string, themeId: TerminalThemeId): Promise<void> {
  const prefPath = path.join(stateDir, PREFS_FILE);
  await fs.mkdir(stateDir, { recursive: true });
  const payload: TerminalUiPreferences = { theme: themeId };
  await fs.writeFile(prefPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
