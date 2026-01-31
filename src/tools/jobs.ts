import crypto from "node:crypto";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { nextCronTimeMs, parseCron, validateTimeZone } from "../scheduler/cron.js";

function randomId(prefix: string): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(10);
  let out = prefix;
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function requireDb(ctx: { db?: unknown }): NexusDatabase | null {
  const db = ctx.db as NexusDatabase | undefined;
  return db ?? null;
}

function currentAgentId(ctx: { request?: { agentId: string } }): string | null {
  const id = ctx.request?.agentId;
  return id ? String(id) : null;
}

function ensureJobOwner(params: { ctxAgentId: string | null; jobOwnerAgentId: string; action: string }): string | null {
  if (!params.ctxAgentId) return null; // CLI/automation context: allow.
  if (params.ctxAgentId !== params.jobOwnerAgentId) {
    return `ERROR: not allowed (${params.action}) — job belongs to agent '${params.jobOwnerAgentId}'`;
  }
  return null;
}

function computeNextRunAt(params: { cron: string; timezone: string; afterMs: number }): number {
  const tz = validateTimeZone(params.timezone);
  const schedule = parseCron(params.cron);
  return nextCronTimeMs({ schedule, afterMs: params.afterMs, timeZone: tz });
}

export const jobCreate = defineTool({
  name: "job_create",
  description:
    "Create a scheduled job (cron) owned by the current agent. PREFERRED for all periodic tasks (price checks, monitoring, reports). No external scripts needed — specify a task description and cron schedule.",
  parameters: z.object({
    name: z.string().min(1).max(120),
    cron: z.string().min(1).max(120).describe("5-field cron: min hour dom mon dow"),
    timezone: z.string().max(64).default("UTC").describe("IANA timezone, e.g. UTC or America/New_York"),
    enabled: z.boolean().default(true),
    task: z.string().min(1).max(4000).describe("What the job should do when it runs"),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const ownerAgentId = currentAgentId(ctx) ?? "main";

    const nowMs = ctx.nowMs();
    const id = randomId("J");
    const nextRunAt = args.enabled ? computeNextRunAt({ cron: args.cron, timezone: args.timezone, afterMs: nowMs }) : null;
    const spec = { mode: "agent_task", task: args.task };

    try {
      db.db
        .prepare(
          "INSERT INTO jobs (id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          ownerAgentId,
          args.name,
          args.cron,
          validateTimeZone(args.timezone),
          args.enabled ? 1 : 0,
          JSON.stringify(spec),
          nextRunAt,
          nowMs,
          nowMs,
        );

      const row = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;
      return JSON.stringify(row, null, 2);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const jobList = defineTool({
  name: "job_list",
  description: "List scheduled jobs. By default, lists jobs owned by the current agent.",
  parameters: z.object({
    includeDisabled: z.boolean().default(true),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const ownerAgentId = currentAgentId(ctx);

    const where = ownerAgentId ? "owner_agent_id = ? AND (? = 1 OR enabled = 1)" : "(? = 1 OR enabled = 1)";
    const sql = `SELECT * FROM jobs WHERE ${where} ORDER BY created_at DESC LIMIT ?`;
    const stmt = db.db.prepare(sql);
    const rows = ownerAgentId
      ? (stmt.all(ownerAgentId, args.includeDisabled ? 1 : 0, args.limit) as any[])
      : (stmt.all(args.includeDisabled ? 1 : 0, args.limit) as any[]);
    return JSON.stringify(rows, null, 2);
  },
});

export const jobGet = defineTool({
  name: "job_get",
  description: "Get a scheduled job by id.",
  parameters: z.object({
    id: z.string().min(1).max(32),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!row) return "ERROR: not found";
    const ownerErr = ensureJobOwner({ ctxAgentId: currentAgentId(ctx), jobOwnerAgentId: String(row.owner_agent_id), action: "job_get" });
    if (ownerErr) return ownerErr;
    return JSON.stringify(row, null, 2);
  },
});

export const jobUpdate = defineTool({
  name: "job_update",
  description: "Update a scheduled job (cron/task/enabled).",
  parameters: z.object({
    id: z.string().min(1).max(32),
    name: z.string().min(1).max(120).optional(),
    cron: z.string().min(1).max(120).optional(),
    timezone: z.string().max(64).optional(),
    enabled: z.boolean().optional(),
    task: z.string().min(1).max(4000).optional(),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const nowMs = ctx.nowMs();

    const existing = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!existing) return "ERROR: not found";
    const ownerErr = ensureJobOwner({
      ctxAgentId: currentAgentId(ctx),
      jobOwnerAgentId: String(existing.owner_agent_id),
      action: "job_update",
    });
    if (ownerErr) return ownerErr;

    const name = args.name ?? String(existing.name);
    const cron = args.cron ?? String(existing.cron);
    const timezone = validateTimeZone(args.timezone ?? String(existing.timezone));

    const enabled = args.enabled === undefined ? Number(existing.enabled) === 1 : args.enabled;

    let spec: any = null;
    try {
      spec = JSON.parse(String(existing.spec_json ?? "{}"));
    } catch {
      spec = {};
    }
    if (args.task !== undefined) spec = { ...(spec ?? {}), mode: "agent_task", task: args.task };
    const specJson = JSON.stringify(spec ?? {});

    const nextRunAt = enabled ? computeNextRunAt({ cron, timezone, afterMs: nowMs }) : null;

    db.db
      .prepare(
        "UPDATE jobs SET name = ?, cron = ?, timezone = ?, enabled = ?, spec_json = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(name, cron, timezone, enabled ? 1 : 0, specJson, nextRunAt, nowMs, args.id);

    const row = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    return JSON.stringify(row, null, 2);
  },
});

export const jobPause = defineTool({
  name: "job_pause",
  description: "Pause a job (disable scheduling).",
  parameters: z.object({
    id: z.string().min(1).max(32),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const nowMs = ctx.nowMs();
    const row = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!row) return "ERROR: not found";
    const ownerErr = ensureJobOwner({ ctxAgentId: currentAgentId(ctx), jobOwnerAgentId: String(row.owner_agent_id), action: "job_pause" });
    if (ownerErr) return ownerErr;
    db.db.prepare("UPDATE jobs SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?").run(nowMs, args.id);
    return "OK";
  },
});

export const jobResume = defineTool({
  name: "job_resume",
  description: "Resume a paused job (enable scheduling).",
  parameters: z.object({
    id: z.string().min(1).max(32),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const nowMs = ctx.nowMs();
    const row = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!row) return "ERROR: not found";
    const ownerErr = ensureJobOwner({ ctxAgentId: currentAgentId(ctx), jobOwnerAgentId: String(row.owner_agent_id), action: "job_resume" });
    if (ownerErr) return ownerErr;
    const nextRunAt = computeNextRunAt({ cron: String(row.cron), timezone: String(row.timezone), afterMs: nowMs });
    db.db.prepare("UPDATE jobs SET enabled = 1, next_run_at = ?, updated_at = ? WHERE id = ?").run(nextRunAt, nowMs, args.id);
    return "OK";
  },
});

export const jobDelete = defineTool({
  name: "job_delete",
  description: "Delete a job and its run history.",
  parameters: z.object({
    id: z.string().min(1).max(32),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!row) return "ERROR: not found";
    const ownerErr = ensureJobOwner({ ctxAgentId: currentAgentId(ctx), jobOwnerAgentId: String(row.owner_agent_id), action: "job_delete" });
    if (ownerErr) return ownerErr;
    const tx = db.db.transaction(() => {
      db.db.prepare("DELETE FROM job_events WHERE job_id = ?").run(args.id);
      db.db.prepare("DELETE FROM job_runs WHERE job_id = ?").run(args.id);
      db.db.prepare("DELETE FROM job_leases WHERE job_id = ?").run(args.id);
      db.db.prepare("DELETE FROM jobs WHERE id = ?").run(args.id);
    });
    tx();
    return "OK";
  },
});

export const jobRunNow = defineTool({
  name: "job_run_now",
  description: "Trigger a job to run ASAP (sets next_run_at to now if enabled).",
  parameters: z.object({
    id: z.string().min(1).max(32),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const nowMs = ctx.nowMs();
    const row = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!row) return "ERROR: not found";
    const ownerErr = ensureJobOwner({ ctxAgentId: currentAgentId(ctx), jobOwnerAgentId: String(row.owner_agent_id), action: "job_run_now" });
    if (ownerErr) return ownerErr;
    if (Number(row.enabled) !== 1) return "ERROR: job is disabled (resume it first)";
    db.db.prepare("UPDATE jobs SET next_run_at = ?, updated_at = ? WHERE id = ?").run(nowMs, nowMs, args.id);
    return "OK";
  },
});

export const jobRuns = defineTool({
  name: "job_runs",
  description: "List recent runs for a job.",
  parameters: z.object({
    id: z.string().min(1).max(32),
    limit: z.number().int().min(1).max(200).default(25),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const job = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!job) return "ERROR: not found";
    const ownerErr = ensureJobOwner({ ctxAgentId: currentAgentId(ctx), jobOwnerAgentId: String(job.owner_agent_id), action: "job_runs" });
    if (ownerErr) return ownerErr;
    const rows = db.db.prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?").all(args.id, args.limit) as any[];
    return JSON.stringify(rows, null, 2);
  },
});

export const jobRunGet = defineTool({
  name: "job_run_get",
  description: "Get a specific job run by id.",
  parameters: z.object({
    runId: z.string().min(1).max(32),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = db.db.prepare("SELECT * FROM job_runs WHERE id = ?").get(args.runId) as any;
    if (!row) return "ERROR: not found";
    const ownerErr = ensureJobOwner({ ctxAgentId: currentAgentId(ctx), jobOwnerAgentId: String(row.owner_agent_id), action: "job_run_get" });
    if (ownerErr) return ownerErr;
    return JSON.stringify(row, null, 2);
  },
});

export const jobEvents = defineTool({
  name: "job_events",
  description: "List recent job events for a job.",
  parameters: z.object({
    id: z.string().min(1).max(32),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const job = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!job) return "ERROR: not found";
    const ownerErr = ensureJobOwner({ ctxAgentId: currentAgentId(ctx), jobOwnerAgentId: String(job.owner_agent_id), action: "job_events" });
    if (ownerErr) return ownerErr;
    const rows = db.db
      .prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(args.id, args.limit) as any[];
    return JSON.stringify(rows, null, 2);
  },
});

