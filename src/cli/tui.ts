import {
  DEFAULT_TERMINAL_THEME,
  getTerminalTheme,
  paintTheme,
  type TerminalTheme,
  type TerminalThemeId,
} from "./terminal-theme.js";

type TuiRole = "prompt" | "assistant" | "system" | "error" | "dim";

type PanelOptions = {
  width?: number;
  borderRole?: TuiRole;
  titleRole?: TuiRole;
  bodyRole?: TuiRole;
};

type SharedTuiOptions = {
  themeId?: TerminalThemeId;
  colorEnabled?: boolean;
  width?: number;
};

const LOGO_LINES = [
  " _   _ ________  ___ _   _ ____  ",
  "| \\ | |  ____\\ \\/ / | | | / __ \\ ",
  "|  \\| | |__   \\  /| | | | |  | |",
  "| . ` |  __|  /  \\| | | | |  | |",
  "| |\\  | |____/ /\\ \\ |_| | |__| |",
  "|_| \\_|______/_/  \\_\\___/ \\____/ ",
];

function clampPanelWidth(width?: number): number {
  const fromStdout = typeof process.stdout.columns === "number" ? process.stdout.columns : 0;
  const candidate = width && Number.isFinite(width) ? Math.floor(width) : fromStdout || 80;
  return Math.min(120, Math.max(48, candidate));
}

function wrapLine(input: string, width: number): string[] {
  if (input.length <= width) return [input];
  const words = input.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [input.slice(0, width)];
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current) out.push(current);
    if (word.length <= width) {
      current = word;
      continue;
    }
    // Hard-wrap extra long tokens so panels don't overflow.
    for (let i = 0; i < word.length; i += width) {
      out.push(word.slice(i, i + width));
    }
    current = "";
  }
  if (current) out.push(current);
  return out.length > 0 ? out : [input.slice(0, width)];
}

export class SharedTui {
  private theme: TerminalTheme;
  private colorEnabled: boolean;
  private panelWidth: number;

  constructor(options: SharedTuiOptions = {}) {
    const themeId = options.themeId ?? DEFAULT_TERMINAL_THEME;
    this.theme = getTerminalTheme(themeId);
    this.colorEnabled = options.colorEnabled ?? Boolean(process.stdout.isTTY);
    this.panelWidth = clampPanelWidth(options.width);
  }

  setTheme(themeId: TerminalThemeId): void {
    this.theme = getTerminalTheme(themeId);
  }

  setColorEnabled(enabled: boolean): void {
    this.colorEnabled = enabled;
  }

  setPanelWidth(width?: number): void {
    this.panelWidth = clampPanelWidth(width);
  }

  paint(role: TuiRole, text: string): string {
    return paintTheme(this.theme, role, text, this.colorEnabled);
  }

  section(title: string): string {
    return this.paint("prompt", `[ ${title} ]`);
  }

  info(text: string): string {
    return `${this.paint("assistant", "->")} ${text}`;
  }

  ok(text: string): string {
    return `${this.paint("system", "[ok]")} ${text}`;
  }

  warn(text: string): string {
    return `${this.paint("error", "[warn]")} ${text}`;
  }

  checkbox(label: string, checked: boolean): string {
    const mark = checked ? this.paint("assistant", "[x]") : this.paint("dim", "[ ]");
    return `${mark} ${label}`;
  }

  panel(title: string, lines: string[], options: PanelOptions = {}): string {
    const width = clampPanelWidth(options.width ?? this.panelWidth);
    const inner = width - 2;
    const borderRole = options.borderRole ?? "dim";
    const titleRole = options.titleRole ?? "system";
    const bodyRole = options.bodyRole ?? "assistant";

    const top = `+${"-".repeat(inner)}+`;
    const titleText = ` ${title} `;
    const titleBar = `|${titleText.padEnd(inner, " ")}|`;

    const body: string[] = [];
    const lineWidth = inner - 2;
    for (const raw of lines) {
      const pieces = wrapLine(raw, lineWidth);
      for (const piece of pieces) {
        body.push(`| ${piece.padEnd(lineWidth, " ")} |`);
      }
    }
    if (body.length === 0) {
      body.push(`| ${"".padEnd(lineWidth, " ")} |`);
    }

    const bottom = top;
    const rendered: string[] = [
      this.paint(borderRole, top),
      this.paint(titleRole, titleBar),
      ...body.map((line) => this.paint(bodyRole, line)),
      this.paint(borderRole, bottom),
    ];
    return rendered.join("\n");
  }

  logoPanel(title: string, subtitle?: string): string {
    const lines = [...LOGO_LINES, ""];
    if (subtitle && subtitle.trim()) {
      lines.push(subtitle.trim());
    }
    return this.panel(title, lines, {
      borderRole: "prompt",
      titleRole: "system",
      bodyRole: "assistant",
    });
  }
}

export function createSharedTui(options: SharedTuiOptions = {}): SharedTui {
  return new SharedTui(options);
}
