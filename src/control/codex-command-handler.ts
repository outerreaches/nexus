import type { ParsedCodexCommand } from "./codex-command.js";
import {
  codexDeviceCodeLogin_start,
  codexLoginFinish,
  codexLogout,
  getCodexAuthStatus,
} from "../llm/codex-auth.js";

export type CodexCommandHandlerDeps = {
  stateDir: string;
  log?: (line: string) => void;
  /** Send a follow-up message to the user after the initial response has been delivered. */
  sendFollowUp?: (text: string) => void;
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

  // login flow — run entirely in background, return immediately
  runCodexLoginInBackground(deps);
  return "Codex: requesting device code from OpenAI... You'll get a message with the login URL shortly.";
}

function runCodexLoginInBackground(deps: CodexCommandHandlerDeps): void {
  codexDeviceCodeLogin_start()
    .then(({ userCode, verificationUrl, poll }) => {
      const msg = [
        "Codex Login — authenticate with your ChatGPT account:",
        "",
        `1. Open: ${verificationUrl}`,
        `2. Enter code: ${userCode}`,
        "",
        "Waiting for authorization (up to 15 min)...",
      ].join("\n");
      deps.log?.(msg);
      deps.sendFollowUp?.(msg);

      return poll({
        onPollTick: () => deps.log?.("codex: waiting for authorization..."),
      });
    })
    .then(async (tokens) => {
      await codexLoginFinish({ stateDir: deps.stateDir, tokens });
      const msg = "Codex: login successful! You can now use /provider codex to switch.";
      deps.log?.(msg);
      deps.sendFollowUp?.(msg);
    })
    .catch((err) => {
      const msg = `Codex login failed: ${err instanceof Error ? err.message : String(err)}`;
      deps.log?.(msg);
      deps.sendFollowUp?.(msg);
    });
}
