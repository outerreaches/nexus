import { type ParsedStopCommand, parseStopCommandText } from "./stop-command.js";
import { type ParsedInfoCommand, parseInfoCommandText } from "./info-command.js";
import { type ParsedHelpCommand, parseHelpCommandText } from "./help-command.js";
import { type ParsedHomeCommand, parseHomeCommandText } from "./home-command.js";

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
    }
  | {
      kind: "home";
      home: ParsedHomeCommand;
    };

export function parseControlCommandText(text: string): ParsedControlCommand | null {
  const help = parseHelpCommandText(text);
  if (help) return { kind: "help", help };

  const stop = parseStopCommandText(text);
  if (stop) return { kind: "stop", stop };

  const info = parseInfoCommandText(text);
  if (info) return { kind: "info", info };

  const home = parseHomeCommandText(text);
  if (home) return { kind: "home", home };

  return null;
}
