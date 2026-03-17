import fs from "node:fs/promises";
import path from "node:path";

export type TerminalThemeId =
  | "terminal-green"
  | "terminal-amber"
  | "dos-bw"
  | "midnight"
  | "light"
  | "nord"
  | "solarized-dark"
  | "dracula"
  | "gruvbox"
  | "high-contrast"
  | "cyberpunk"
  | "ocean"
  | "paper";

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
  /** When true, panel() keeps background colors active across lines instead of resetting per-line. */
  continuousBg?: boolean;
};

const RESET = "\x1b[0m";

export const DEFAULT_TERMINAL_THEME: TerminalThemeId = "terminal-green";

const THEMES: Record<TerminalThemeId, TerminalTheme> = {
  "terminal-green": {
    id: "terminal-green",
    label: "Terminal Green",
    description: "Classic phosphor-green CRT vibe.",
    // Use the same 256-color + truecolor layering as the richer themes so terminals
    // that support RGB get an exact phosphor shade while older terminals still get
    // a reasonable indexed-color fallback.
    prompt: "\x1b[38;5;119m\x1b[38;2;120;255;100m",
    assistant: "\x1b[38;5;46m\x1b[38;2;57;255;20m",
    system: "\x1b[38;5;83m\x1b[38;2;51;255;51;1m",
    error: "\x1b[38;5;203m\x1b[38;2;255;51;51m",
    dim: "\x1b[38;5;28m\x1b[38;2;17;170;17;2m",
    reset: RESET,
  },
  "terminal-amber": {
    id: "terminal-amber",
    label: "Terminal Amber",
    description: "Warm amber monitor style.",
    prompt: "\x1b[38;5;220m\x1b[38;2;255;204;0m",
    assistant: "\x1b[38;5;214m\x1b[38;2;255;176;0m",
    system: "\x1b[38;5;220m\x1b[38;2;255;204;0;1m",
    error: "\x1b[38;5;203m\x1b[38;2;255;51;51m",
    dim: "\x1b[38;5;130m\x1b[38;2;170;102;0;2m",
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
  midnight: {
    id: "midnight",
    label: "Midnight",
    description: "Blue-background retro file-manager style.",
    prompt: "\x1b[97;44m",
    assistant: "\x1b[37;44m",
    system: "\x1b[30;46m",
    error: "\x1b[37;41m",
    dim: "\x1b[36;44m",
    reset: RESET,
    continuousBg: true,
  },
  light: {
    id: "light",
    label: "Light",
    description: "High-contrast light-friendly palette.",
    prompt: "\x1b[30;47m",
    assistant: "\x1b[30;47m",
    system: "\x1b[30;47;1m",
    error: "\x1b[31;47;1m",
    dim: "\x1b[30;47;2m",
    reset: RESET,
    continuousBg: true,
  },
  nord: {
    id: "nord",
    label: "Nord",
    description: "Frosty arctic blues.",
    prompt: "\x1b[38;2;136;192;208m\x1b[48;5;238m\x1b[48;2;46;52;64m",
    assistant: "\x1b[38;2;216;222;233m\x1b[48;5;238m\x1b[48;2;46;52;64m",
    system: "\x1b[38;2;129;161;193;1m\x1b[48;5;238m\x1b[48;2;46;52;64m",
    error: "\x1b[38;2;191;97;106m\x1b[48;5;238m\x1b[48;2;46;52;64m",
    dim: "\x1b[38;2;76;86;106m\x1b[48;5;238m\x1b[48;2;46;52;64m",
    reset: RESET,
    continuousBg: true,
  },
  "solarized-dark": {
    id: "solarized-dark",
    label: "Solarized Dark",
    description: "Classic low-contrast beige and cyan.",
    prompt: "\x1b[38;2;42;161;152m\x1b[48;5;23m\x1b[48;2;0;43;54m",
    assistant: "\x1b[38;2;131;148;150m\x1b[48;5;23m\x1b[48;2;0;43;54m",
    system: "\x1b[38;2;181;137;0;1m\x1b[48;5;23m\x1b[48;2;0;43;54m",
    error: "\x1b[38;2;220;50;47m\x1b[48;5;23m\x1b[48;2;0;43;54m",
    dim: "\x1b[38;2;88;110;117m\x1b[48;5;23m\x1b[48;2;0;43;54m",
    reset: RESET,
    continuousBg: true,
  },
  dracula: {
    id: "dracula",
    label: "Dracula",
    description: "Purple, pink, and cyan dark theme.",
    prompt: "\x1b[38;2;189;147;249m\x1b[48;5;236m\x1b[48;2;40;42;54m",
    assistant: "\x1b[38;2;139;233;253m\x1b[48;5;236m\x1b[48;2;40;42;54m",
    system: "\x1b[38;2;255;121;198;1m\x1b[48;5;236m\x1b[48;2;40;42;54m",
    error: "\x1b[38;2;255;85;85m\x1b[48;5;236m\x1b[48;2;40;42;54m",
    dim: "\x1b[38;2;98;114;164m\x1b[48;5;236m\x1b[48;2;40;42;54m",
    reset: RESET,
    continuousBg: true,
  },
  gruvbox: {
    id: "gruvbox",
    label: "Gruvbox",
    description: "Warm retro dark with browns and beiges.",
    prompt: "\x1b[38;2;215;153;33m\x1b[48;5;235m\x1b[48;2;40;40;40m",
    assistant: "\x1b[38;2;235;219;178m\x1b[48;5;235m\x1b[48;2;40;40;40m",
    system: "\x1b[38;2;181;118;20;1m\x1b[48;5;235m\x1b[48;2;40;40;40m",
    error: "\x1b[38;2;204;36;29m\x1b[48;5;235m\x1b[48;2;40;40;40m",
    dim: "\x1b[38;2;146;131;116m\x1b[48;5;235m\x1b[48;2;40;40;40m",
    reset: RESET,
    continuousBg: true,
  },
  "high-contrast": {
    id: "high-contrast",
    label: "High Contrast",
    description: "Pure black and white for accessibility.",
    prompt: "\x1b[97;40;1m",
    assistant: "\x1b[97;40m",
    system: "\x1b[30;107;1m",
    error: "\x1b[97;40;1;4m",
    dim: "\x1b[37;40m",
    reset: RESET,
    continuousBg: true,
  },
  cyberpunk: {
    id: "cyberpunk",
    label: "Cyberpunk",
    description: "Neon pink and cyan on dark.",
    prompt: "\x1b[38;2;0;245;255m\x1b[48;5;233m\x1b[48;2;10;8;18m",
    assistant: "\x1b[38;2;255;79;216m\x1b[48;5;233m\x1b[48;2;10;8;18m",
    system: "\x1b[38;2;255;0;200;1m\x1b[48;5;233m\x1b[48;2;10;8;18m",
    error: "\x1b[38;2;255;95;151;1m\x1b[48;5;233m\x1b[48;2;10;8;18m",
    dim: "\x1b[38;2;127;66;198m\x1b[48;5;233m\x1b[48;2;10;8;18m",
    reset: RESET,
    continuousBg: true,
  },
  ocean: {
    id: "ocean",
    label: "Ocean",
    description: "Deep teals and blues.",
    prompt: "\x1b[38;2;42;157;143m\x1b[48;5;23m\x1b[48;2;0;26;38m",
    assistant: "\x1b[38;2;69;123;157m\x1b[48;5;23m\x1b[48;2;0;26;38m",
    system: "\x1b[38;2;142;202;230;1m\x1b[48;5;23m\x1b[48;2;0;26;38m",
    error: "\x1b[38;2;214;106;106m\x1b[48;5;23m\x1b[48;2;0;26;38m",
    dim: "\x1b[38;2;70;95;110m\x1b[48;5;23m\x1b[48;2;0;26;38m",
    reset: RESET,
    continuousBg: true,
  },
  paper: {
    id: "paper",
    label: "Paper",
    description: "Warm off-white with sepia tones.",
    prompt: "\x1b[38;2;133;94;66m\x1b[48;5;230m\x1b[48;2;250;246;236m",
    assistant: "\x1b[38;2;91;70;54m\x1b[48;5;230m\x1b[48;2;250;246;236m",
    system: "\x1b[38;2;120;80;52;1m\x1b[48;5;230m\x1b[48;2;250;246;236m",
    error: "\x1b[38;2;150;61;51m\x1b[48;5;230m\x1b[48;2;250;246;236m",
    dim: "\x1b[38;2;154;134;110m\x1b[48;5;230m\x1b[48;2;250;246;236m",
    reset: RESET,
    continuousBg: true,
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
  midnight: "midnight",
  mc: "midnight",
  blue: "midnight",
  "midnight-commander": "midnight",
  light: "light",
  nord: "nord",
  "solarized-dark": "solarized-dark",
  solarized: "solarized-dark",
  dracula: "dracula",
  gruvbox: "gruvbox",
  "high-contrast": "high-contrast",
  hc: "high-contrast",
  cyberpunk: "cyberpunk",
  neon: "cyberpunk",
  ocean: "ocean",
  paper: "paper",
  sepia: "paper",
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
