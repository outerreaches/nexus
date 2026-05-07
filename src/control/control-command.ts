import { type ParsedStopCommand, parseStopCommandText } from "./stop-command.js";
import { type ParsedInfoCommand, parseInfoCommandText } from "./info-command.js";
import { type ParsedHelpCommand, parseHelpCommandText } from "./help-command.js";
import { type ParsedHomeCommand, parseHomeCommandText } from "./home-command.js";
import { type ParsedModelSettingsCommand, parseModelSettingsCommandText } from "./model-settings-command.js";
import { type ParsedCodexCommand, parseCodexCommandText } from "./codex-command.js";
import { type ParsedStatusCommand, parseStatusCommandText } from "./status-command.js";

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
    }
  | {
      kind: "model_settings";
      modelSettings: ParsedModelSettingsCommand;
    }
  | {
      kind: "codex";
      codex: ParsedCodexCommand;
    }
  | {
      kind: "status";
      status: ParsedStatusCommand;
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

  const codex = parseCodexCommandText(text);
  if (codex) return { kind: "codex", codex };

  const status = parseStatusCommandText(text);
  if (status) return { kind: "status", status };

  const modelSettings = parseModelSettingsCommandText(text);
  if (modelSettings) return { kind: "model_settings", modelSettings };

  return null;
}
