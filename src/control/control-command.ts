import { type ParsedStopCommand, parseStopCommandText } from "./stop-command.js";
import { type ParsedInfoCommand, parseInfoCommandText } from "./info-command.js";
import { type ParsedHelpCommand, parseHelpCommandText } from "./help-command.js";

export type ParsedControlCommand =
  | {
      kind: "help";
      help: ParsedHelpCommand;
    }
  | {
      kind: "stop";
      stop: ParsedStopCommand;
    }
  | {
      kind: "info";
      info: ParsedInfoCommand;
    };

export function parseControlCommandText(text: string): ParsedControlCommand | null {
  const help = parseHelpCommandText(text);
  if (help) return { kind: "help", help };

  const stop = parseStopCommandText(text);
  if (stop) return { kind: "stop", stop };

  const info = parseInfoCommandText(text);
  if (info) return { kind: "info", info };

  return null;
}
