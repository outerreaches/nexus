import { type ParsedControlCommand, parseControlCommandText } from "./control-command.js";
import { type ParsedThemeCommand, parseThemeCommandText } from "./theme-command.js";

export type ParsedTerminalCommand =
  | {
      kind: "control";
      control: ParsedControlCommand;
    }
  | {
      kind: "theme";
      theme: ParsedThemeCommand;
    };

export function parseTerminalCommandText(text: string): ParsedTerminalCommand | null {
  const control = parseControlCommandText(text);
  if (control) return { kind: "control", control };

  const theme = parseThemeCommandText(text);
  if (theme) return { kind: "theme", theme };

  return null;
}
