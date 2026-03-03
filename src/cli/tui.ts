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
  useUnicode?: boolean;
  width?: number;
};

type BoxChars = {
  tl: string; tr: string; bl: string; br: string;
  h: string; v: string;
};

const UNICODE_BOX: BoxChars = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };
const ASCII_BOX: BoxChars = { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };

function detectUnicodeSupport(): boolean {
  const override = (process.env.NEXUS_TUI_UNICODE ?? "").trim().toLowerCase();
  if (override === "1" || override === "true" || override === "yes") return true;
  if (override === "0" || override === "false" || override === "no") return false;

  const term = (process.env.TERM ?? "").trim().toLowerCase();
  if (term === "dumb") return false;

  const locale = (process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "").trim().toLowerCase();
  if (!locale) return true;
  if (locale === "c" || locale === "posix") return false;
  if (locale.includes("utf")) return true;
  return true;
}

const LOGO_LINES = [
  "███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗",
  "████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝",
  "██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗",
  "██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║",
  "██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║",
  "╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
];

function clampPanelWidth(width?: number): number {
  const fromStdout = typeof process.stdout.columns === "number" ? process.stdout.columns : 0;
  const candidate = width && Number.isFinite(width) ? Math.floor(width) : fromStdout || 80;
  return Math.min(120, Math.max(48, candidate));
}

function wrapLine(input: string, width: number): string[] {
  if (input.length <= width) return [input];

  // Preserve leading whitespace so indented content stays indented.
  const leadingMatch = input.match(/^(\s+)/);
  const indent = leadingMatch ? leadingMatch[1] : "";
  const content = indent ? input.slice(indent.length) : input;
  const effectiveWidth = width - indent.length;
  if (effectiveWidth <= 0) return [input.slice(0, width)];

  const words = content.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [input.slice(0, width)];
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= effectiveWidth) {
      current = next;
      continue;
    }
    if (current) out.push(current);
    if (word.length <= effectiveWidth) {
      current = word;
      continue;
    }
    // Hard-wrap extra long tokens so panels don't overflow.
    for (let i = 0; i < word.length; i += effectiveWidth) {
      out.push(word.slice(i, i + effectiveWidth));
    }
    current = "";
  }
  if (current) out.push(current);
  if (out.length === 0) return [input.slice(0, width)];
  return out.map((line) => `${indent}${line}`);
}

export class SharedTui {
  private theme: TerminalTheme;
  private colorEnabled: boolean;
  private panelWidth: number;
  private box: BoxChars;

  constructor(options: SharedTuiOptions = {}) {
    const themeId = options.themeId ?? DEFAULT_TERMINAL_THEME;
    this.theme = getTerminalTheme(themeId);
    this.colorEnabled = options.colorEnabled ?? Boolean(process.stdout.isTTY);
    this.panelWidth = clampPanelWidth(options.width);
    const unicode = options.useUnicode ?? detectUnicodeSupport();
    this.box = unicode ? UNICODE_BOX : ASCII_BOX;
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

  /** Apply role color without a trailing reset — used for continuous-bg panel rendering. */
  private paintNoReset(role: TuiRole, text: string): string {
    if (!this.colorEnabled) return text;
    return `${this.theme[role]}${text}`;
  }

  promptString(): string {
    if (!this.colorEnabled) return "> ";
    // Keep prompt style active so user input inherits theme colors/background.
    return `${this.theme.prompt}> `;
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
    const { tl, tr, bl, br, h, v } = this.box;

    const top = `${tl}${h.repeat(inner)}${tr}`;
    const titleText = ` ${title} `;
    const titleBar = `${v}${titleText.padEnd(inner, " ")}${v}`;

    const body: string[] = [];
    const lineWidth = inner - 2;
    for (const raw of lines) {
      const pieces = wrapLine(raw, lineWidth);
      for (const piece of pieces) {
        body.push(`${v} ${piece.padEnd(lineWidth, " ")} ${v}`);
      }
    }
    if (body.length === 0) {
      body.push(`${v} ${"".padEnd(lineWidth, " ")} ${v}`);
    }

    const bottom = `${bl}${h.repeat(inner)}${br}`;

    // For themes with background colors (e.g. midnight), avoid resetting bg between
    // lines so the background stays continuous across the entire panel.
    if (this.theme.continuousBg && this.colorEnabled) {
      const parts = [
        this.paintNoReset(borderRole, top),
        this.paintNoReset(titleRole, titleBar),
        ...body.map((line) => this.paintNoReset(bodyRole, line)),
        this.paintNoReset(borderRole, bottom),
      ];
      return parts.join("\n") + this.theme.reset;
    }

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
