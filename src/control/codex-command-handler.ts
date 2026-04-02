import type { ParsedCodexCommand } from "./codex-command.js";
import {
  codexLogin,
  codexLogout,
  getCodexAuthStatus,
  type DeviceCodeLoginCallbacks,
} from "../llm/codex-auth.js";

export type CodexCommandHandlerDeps = {
  stateDir: string;
  log?: (line: string) => void;
  /** Send a message to the user (e.g. Telegram). Used for device code display. */
  sendMessage?: (text: string) => Promise<void>;
};

export async function executeCodexCommand(params: {
  command: ParsedCodexCommand;
  deps: CodexCommandHandlerDeps;
}): Promise<string> {
  const { command, deps } = params;

  if (command.error) return `ERROR: ${command.error}`;

  if (command.kind === "status") {
    const status = await getCodexAuthStatus(deps.stateDir);
    if (!status.loggedIn) {
      return "Codex: not logged in. Use /codex login to authenticate with your ChatGPT account.";
    }
    const parts = ["Codex: logged in"];
    if (status.lastRefresh) parts.push(`last refresh: ${status.lastRefresh}`);
    if (status.tokenExpiring) parts.push("(token expiring soon — will auto-refresh)");
    return parts.join(" · ");
  }

  if (command.kind === "logout") {
    const removed = await codexLogout(deps.stateDir);
    return removed
      ? "Codex: logged out. Tokens removed."
      : "Codex: no credentials found to remove.";
  }

  // login flow
  const callbacks: DeviceCodeLoginCallbacks = {
    onUserCode: ({ verificationUrl, userCode }) => {
      const msg = [
        "🔑 Codex Login — authenticate with your ChatGPT account:",
        "",
        `1. Open: ${verificationUrl}`,
        `2. Enter code: **${userCode}**`,
        "",
        "Waiting for authorization...",
      ].join("\n");

      deps.log?.(msg);
      deps.sendMessage?.(msg);
    },
    onPollTick: () => {
      deps.log?.("codex: waiting for authorization...");
    },
  };

  try {
    await codexLogin({ stateDir: deps.stateDir, callbacks });
    return "Codex: login successful! You can now use the \"codex\" provider in your LLM routing config.";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Codex login failed: ${msg}`;
  }
}
