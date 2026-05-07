import path from "node:path";

import { getCodexAuthStatus } from "../llm/codex-auth.js";
import type { ModelRouter } from "../llm/model-router.js";
import type { NexusConfig } from "../state/config.js";
import type { NexusDatabase } from "../storage/database.js";
import { listDeployRequests } from "../storage/deploy-requests.js";
import type { ParsedStatusCommand } from "./status-command.js";

export type StatusCommandHandlerDeps = {
  db?: NexusDatabase;
  config: NexusConfig;
  modelRouter?: ModelRouter;
  stateDir?: string;
  /** Returns "active" | "standby" | "unknown" — usually backed by the gateway runtime. */
  getMode?: () => string;
  /** Epoch ms of last activation, or null while standby/booting. */
  getActivatedAt?: () => number | null;
  /** Epoch ms when the handler runs (override for tests). */
  nowMs?: () => number;
  /** Default agent id to query routing for. */
  defaultAgentId?: string;
};

const DEFAULT_PRESET_FOR_ROUTE = "orchestrator";

export async function executeStatusCommand(params: {
  command: ParsedStatusCommand;
  deps: StatusCommandHandlerDeps;
}): Promise<string> {
  const { deps } = params;
  const nowMs = deps.nowMs ? deps.nowMs() : Date.now();
  const sections: string[] = [];

  sections.push(renderSlotSection(deps, nowMs));
  sections.push(renderRoutingSection(deps));
  sections.push(await renderProvidersSection(deps));
  sections.push(renderPendingSection(deps, nowMs));
  sections.push(renderChannelsSection(deps));

  return sections.filter(Boolean).join("\n\n");
}

// ── Slot ─────────────────────────────────────────────────────────────────────

function renderSlotSection(deps: StatusCommandHandlerDeps, nowMs: number): string {
  const mode = deps.getMode ? deps.getMode() : "unknown";
  const activatedAt = deps.getActivatedAt ? deps.getActivatedAt() : null;
  const profile = deps.config.runtime.profile;
  const lines: string[] = ["[Slot]"];
  lines.push(`mode=${mode} profile=${profile}`);
  if (activatedAt) {
    lines.push(`uptime=${formatDurationMs(Math.max(0, nowMs - activatedAt))} (since ${new Date(activatedAt).toISOString()})`);
  } else {
    lines.push("uptime=(not yet active)");
  }
  return lines.join("\n");
}

// ── Routing ──────────────────────────────────────────────────────────────────

function renderRoutingSection(deps: StatusCommandHandlerDeps): string {
  const lines: string[] = ["[Routing]"];
  if (!deps.modelRouter) {
    lines.push("model router not initialized");
    return lines.join("\n");
  }
  const agentId = deps.defaultAgentId ?? "main";
  const route = safeResolve(deps.modelRouter, agentId, DEFAULT_PRESET_FOR_ROUTE);
  if (route) {
    lines.push(`default (${DEFAULT_PRESET_FOR_ROUTE}): ${route.primaryProvider}/${route.primary.model} (source=${route.source})`);
  } else {
    lines.push("default: <unable to resolve>");
  }

  const presetOverrides = Object.keys(deps.config.llm.routing.byPreset ?? {});
  if (presetOverrides.length > 0) {
    const summary = presetOverrides
      .map((name) => {
        const r = safeResolve(deps.modelRouter!, agentId, name);
        return r ? `${name}→${r.primaryProvider}/${r.primary.model}` : `${name}→<error>`;
      })
      .join(", ");
    lines.push(`byPreset: ${summary}`);
  } else {
    lines.push("byPreset: (none)");
  }

  const toolRouting = deps.config.llm.toolRouting;
  const toolByPreset = Object.keys(toolRouting?.byPreset ?? {});
  const toolDefault = Object.keys(toolRouting?.default ?? {});
  const toolByAgent = Object.keys(toolRouting?.byAgent ?? {});
  if (toolByPreset.length + toolDefault.length + toolByAgent.length > 0) {
    const summary = [
      toolDefault.length > 0 ? `default(${toolDefault.length})` : null,
      toolByPreset.length > 0 ? `byPreset(${toolByPreset.length})` : null,
      toolByAgent.length > 0 ? `byAgent(${toolByAgent.length})` : null,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`toolRouting: ${summary}`);
  } else {
    lines.push("toolRouting: (none)");
  }

  return lines.join("\n");
}

function safeResolve(
  router: ModelRouter,
  agentId: string,
  preset: string,
): { primaryProvider: string; primary: { model: string }; source: string } | null {
  try {
    return router.resolve({ agentId, preset });
  } catch {
    return null;
  }
}

// ── Providers ────────────────────────────────────────────────────────────────

async function renderProvidersSection(deps: StatusCommandHandlerDeps): Promise<string> {
  const lines: string[] = ["[Providers]"];
  const providers = deps.config.llm.providers ?? {};
  const names = Object.keys(providers).sort();
  if (names.length === 0) {
    lines.push("(no providers configured)");
    return lines.join("\n");
  }

  for (const name of names) {
    const cfg = providers[name];
    if (!cfg) continue;
    const state = await providerHealth({
      name,
      apiKey: cfg.apiKey,
      stateDir: deps.stateDir,
    });
    const baseUrl = cfg.baseUrl ? compactUrl(cfg.baseUrl) : "(no base url)";
    lines.push(`  ${pad(name, 14)} ${pad(state, 18)} ${baseUrl}`);
  }
  return lines.join("\n");
}

async function providerHealth(params: {
  name: string;
  apiKey: string | undefined;
  stateDir: string | undefined;
}): Promise<string> {
  if (params.name === "codex") {
    if (!params.stateDir) return "stateDir missing";
    try {
      const status = await getCodexAuthStatus(params.stateDir);
      if (!status.loggedIn) return "login required";
      return "ok";
    } catch (err) {
      return `error: ${truncate(err instanceof Error ? err.message : String(err), 30)}`;
    }
  }
  if (!params.apiKey) return "missing key";
  return "ok";
}

// ── Pending ──────────────────────────────────────────────────────────────────

function renderPendingSection(deps: StatusCommandHandlerDeps, nowMs: number): string {
  const lines: string[] = ["[Pending]"];
  if (deps.db) {
    try {
      const pendingApprovals = listDeployRequests(deps.db, {
        statuses: ["pending_approval"],
        limit: 25,
      });
      const queuedDeploys = listDeployRequests(deps.db, {
        statuses: ["queued", "deploying"],
        limit: 25,
      });
      lines.push(`deploy_approvals: ${pendingApprovals.length} pending, ${queuedDeploys.length} in flight`);
      if (pendingApprovals.length > 0) {
        for (const req of pendingApprovals.slice(0, 3)) {
          const ageMs = Math.max(0, nowMs - req.createdAt);
          lines.push(`  - ${req.approvalId} (age ${formatDurationMs(ageMs)})  /act ${req.approvalId} approve`);
        }
        if (pendingApprovals.length > 3) {
          lines.push(`  - (+${pendingApprovals.length - 3} more)`);
        }
      }
    } catch (err) {
      lines.push(`deploy_approvals: <error: ${truncate(err instanceof Error ? err.message : String(err), 60)}>`);
    }

    try {
      const runningProcessRows = deps.db.db
        .prepare("SELECT COUNT(*) AS cnt FROM process_runs WHERE status = 'running'")
        .get() as { cnt: number } | undefined;
      const pendingNotifyRows = deps.db.db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM process_runs WHERE notified_at IS NULL AND status != 'running' AND notify_mode != 'never'",
        )
        .get() as { cnt: number } | undefined;
      lines.push(`process_runs: ${runningProcessRows?.cnt ?? 0} running, ${pendingNotifyRows?.cnt ?? 0} awaiting notification`);
    } catch (err) {
      lines.push(`process_runs: <error: ${truncate(err instanceof Error ? err.message : String(err), 60)}>`);
    }

    try {
      const enabledJobsRow = deps.db.db
        .prepare("SELECT COUNT(*) AS cnt FROM jobs WHERE enabled = 1")
        .get() as { cnt: number } | undefined;
      lines.push(`scheduler: enabled=${deps.config.scheduler.enabled} jobs=${enabledJobsRow?.cnt ?? 0}`);
    } catch (err) {
      lines.push(`scheduler: <error: ${truncate(err instanceof Error ? err.message : String(err), 60)}>`);
    }
  } else {
    lines.push("(database not available)");
  }
  return lines.join("\n");
}

// ── Channels ─────────────────────────────────────────────────────────────────

function renderChannelsSection(deps: StatusCommandHandlerDeps): string {
  const lines: string[] = ["[Channels]"];
  const tg = deps.config.channels?.telegram;
  if (tg?.enabled) {
    lines.push(`telegram: enabled mode=${tg.mode ?? "polling"} agentId=${tg.agentId ?? "main"}`);
  } else {
    lines.push("telegram: disabled");
  }
  const fed = deps.config.federation;
  lines.push(`federation: enabled=${fed.enabled} instance=${fed.localInstanceId}`);
  return lines.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pad(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function compactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.length > 1 ? parsed.pathname : "";
    return `${parsed.host}${tail}`;
  } catch {
    return path.basename(url);
  }
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin > 0 ? `${hr}h${remMin}m` : `${hr}h`;
  const days = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr > 0 ? `${days}d${remHr}h` : `${days}d`;
}
