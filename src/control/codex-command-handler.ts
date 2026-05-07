import type { ParsedCodexCommand } from "./codex-command.js";
import {
  codexDeviceCodeLogin_start,
  codexLoginFinish,
  codexLogout,
  getCodexAuthStatus,
} from "../llm/codex-auth.js";

export type CodexLoginEvent = {
  kind: "started" | "succeeded" | "failed";
  title: string;
  body: string;
};

export type CodexCommandHandlerDeps = {
  stateDir: string;
  log?: (line: string) => void;
  /** Send a follow-up message to the user after the initial response has been delivered. */
  sendFollowUp?: (text: string) => void;
  /**
   * Optional secondary delivery for completion notifications. Wired by the
   * gateway to the run-report broker so home-channel users see "login
   * succeeded" even if they invoked /codex login from a closed terminal.
   * Errors are swallowed by the caller — sendFollowUp remains the primary
   * delivery channel.
   */
  enqueueLoginEvent?: (event: CodexLoginEvent) => void;
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
      deps.enqueueLoginEvent?.({
        kind: "started",
        title: "Codex login started",
        body: `Open ${verificationUrl} and enter code ${userCode}.`,
      });

      return poll({
        onPollTick: () => deps.log?.("codex: waiting for authorization..."),
      });
    })
    .then(async (tokens) => {
      await codexLoginFinish({ stateDir: deps.stateDir, tokens });
      const msg = "Codex: login successful! You can now use /provider codex to switch.";
      deps.log?.(msg);
      deps.sendFollowUp?.(msg);
      deps.enqueueLoginEvent?.({
        kind: "succeeded",
        title: "Codex login succeeded",
        body: "Codex provider is ready. Use /provider codex to switch.",
      });
    })
    .catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      const msg = `Codex login failed: ${detail}`;
      deps.log?.(msg);
      deps.sendFollowUp?.(msg);
      deps.enqueueLoginEvent?.({
        kind: "failed",
        title: "Codex login failed",
        body: detail,
      });
    });
}
