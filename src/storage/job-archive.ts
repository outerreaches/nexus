import crypto from "node:crypto";

import type { NexusDatabase } from "./database.js";
import { deleteContextCursorsByFlow } from "./context-cursors.js";

function randomId(prefix: string): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(10);
  let out = prefix;
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export type ArchiveDeleteJobParams = {
  db: NexusDatabase;
  jobId: string;
  archivedAtMs: number;
  archiveReason: string;
  archivedBy: string;
  metadata?: Record<string, unknown>;
};

export type ArchiveDeleteJobResult = {
  found: boolean;
  jobArchiveId: string | null;
  archivedRuns: number;
  archivedEvents: number;
};

export function archiveAndDeleteJobInTx(params: ArchiveDeleteJobParams): ArchiveDeleteJobResult {
  const job = params.db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(params.jobId) as Record<string, unknown> | undefined;
  if (!job) {
    return { found: false, jobArchiveId: null, archivedRuns: 0, archivedEvents: 0 };
  }

  const runs = params.db.db.prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at ASC").all(params.jobId) as Record<
    string,
    unknown
  >[];
  const events = params.db.db
    .prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at ASC")
    .all(params.jobId) as Record<string, unknown>[];

  const metadataJson = JSON.stringify(params.metadata ?? {});
  const jobArchiveId = randomId("JA");

  params.db.db
    .prepare(
      `INSERT INTO jobs_archive (
        archive_id, job_id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, last_run_at,
        consecutive_failures, last_failure_at, last_notified_at, created_at, updated_at,
        archived_at, archive_reason, archived_by, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jobArchiveId,
      String(job.id),
      String(job.owner_agent_id ?? ""),
      String(job.name ?? ""),
      String(job.cron ?? ""),
      String(job.timezone ?? "UTC"),
      Number(job.enabled ?? 0),
      String(job.spec_json ?? "{}"),
      job.next_run_at ?? null,
      job.last_run_at ?? null,
      Number(job.consecutive_failures ?? 0),
      job.last_failure_at ?? null,
      job.last_notified_at ?? null,
      Number(job.created_at ?? params.archivedAtMs),
      Number(job.updated_at ?? params.archivedAtMs),
      params.archivedAtMs,
      params.archiveReason,
      params.archivedBy,
      metadataJson,
    );

  const insertRun = params.db.db.prepare(
    `INSERT INTO job_runs_archive (
      archive_id, run_id, job_id, owner_agent_id, scheduled_for, started_at, ended_at, status, error, output,
      tool_calls_used, iterations_used, archived_at, archive_reason, archived_by, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let archivedRuns = 0;
  for (const run of runs) {
    insertRun.run(
      randomId("JRA"),
      String(run.id ?? ""),
      String(run.job_id ?? params.jobId),
      String(run.owner_agent_id ?? ""),
      Number(run.scheduled_for ?? params.archivedAtMs),
      Number(run.started_at ?? params.archivedAtMs),
      run.ended_at ?? null,
      String(run.status ?? "unknown"),
      run.error ?? null,
      run.output ?? null,
      run.tool_calls_used ?? null,
      run.iterations_used ?? null,
      params.archivedAtMs,
      params.archiveReason,
      params.archivedBy,
      metadataJson,
    );
    archivedRuns += 1;
  }

  const insertEvent = params.db.db.prepare(
    `INSERT INTO job_events_archive (
      archive_id, event_id, job_id, run_id, owner_agent_id, kind, payload_json, created_at, handled_at,
      archived_at, archive_reason, archived_by, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let archivedEvents = 0;
  for (const event of events) {
    insertEvent.run(
      randomId("JEA"),
      String(event.id ?? ""),
      String(event.job_id ?? params.jobId),
      event.run_id ?? null,
      String(event.owner_agent_id ?? ""),
      String(event.kind ?? ""),
      String(event.payload_json ?? "{}"),
      Number(event.created_at ?? params.archivedAtMs),
      event.handled_at ?? null,
      params.archivedAtMs,
      params.archiveReason,
      params.archivedBy,
      metadataJson,
    );
    archivedEvents += 1;
  }

  params.db.db.prepare("DELETE FROM job_events WHERE job_id = ?").run(params.jobId);
  params.db.db.prepare("DELETE FROM job_runs WHERE job_id = ?").run(params.jobId);
  params.db.db.prepare("DELETE FROM job_leases WHERE job_id = ?").run(params.jobId);
  params.db.db.prepare("DELETE FROM jobs WHERE id = ?").run(params.jobId);
  deleteContextCursorsByFlow(params.db, { flowType: "job", flowKey: params.jobId });

  return { found: true, jobArchiveId, archivedRuns, archivedEvents };
}

export function archiveAndDeleteJob(params: ArchiveDeleteJobParams): ArchiveDeleteJobResult {
  const tx = params.db.db.transaction((inner: ArchiveDeleteJobParams) => archiveAndDeleteJobInTx(inner));
  return tx(params);
}
