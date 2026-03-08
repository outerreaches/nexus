import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

const execFileAsync = promisify(execFile);

const CandidateIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "candidateId must use path-safe characters");
const CandidateStatusSchema = z.enum([
  "active",
  "pending_classification",
  "pending_approval",
  "auto_deploying",
  "approved",
  "deployed",
  "rejected",
  "abandoned",
  "expired",
  "failed",
]);
const CandidateVerificationStatusSchema = z.enum(["pending", "passed", "failed"]);
const CandidateApprovalStatusSchema = z.enum(["pending", "approved", "rejected"]);
const CandidateClassificationSchema = z.enum(["pending", "intake_only", "approval_required"]);

export const CandidateBindingSchema = z.object({
  candidateId: CandidateIdSchema,
  baseSha: z.string().min(1),
  repoDir: z.string(),
});

export type CandidateBinding = z.infer<typeof CandidateBindingSchema>;

export const CandidateRecordSchema = CandidateBindingSchema.extend({
  liveCodeDir: z.string(),
  candidateDir: z.string(),
  metadataPath: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastActivityAt: z.number().int().nonnegative(),
  ownerRunId: z.string().min(1).nullable().default(null),
  ownerSessionId: z.string().min(1).nullable().default(null),
  status: CandidateStatusSchema.default("active"),
  verificationStatus: CandidateVerificationStatusSchema.default("pending"),
  approvalStatus: CandidateApprovalStatusSchema.default("pending"),
  classification: CandidateClassificationSchema.default("pending"),
  approvalId: z.string().min(1).nullable().default(null),
  verificationFingerprint: z.string().min(1).nullable().default(null),
  verifiedAt: z.number().int().nonnegative().nullable().default(null),
  lastError: z.string().min(1).nullable().default(null),
});

export type CandidateRecord = z.infer<typeof CandidateRecordSchema>;
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;
export type CandidateVerificationStatus = z.infer<typeof CandidateVerificationStatusSchema>;
export type CandidateApprovalStatus = z.infer<typeof CandidateApprovalStatusSchema>;
export type CandidateClassification = z.infer<typeof CandidateClassificationSchema>;

export type CandidateGcPolicy = {
  activeTtlMs: number;
  deployedRetentionMs: number;
  softCapPerLiveCodeDir: number;
};

export type CreateCandidateParams = {
  liveCodeDir: string;
  candidateRootDir: string;
  ownerRunId?: string | null;
  ownerSessionId?: string | null;
  candidateId?: string;
  nowMs?: number;
  gcPolicy?: Partial<CandidateGcPolicy>;
};

export type UpdateCandidatePatch = {
  status?: CandidateStatus;
  verificationStatus?: CandidateVerificationStatus;
  approvalStatus?: CandidateApprovalStatus;
  classification?: CandidateClassification;
  approvalId?: string | null;
  verificationFingerprint?: string | null;
  verifiedAt?: number | null;
  lastError?: string | null;
  ownerRunId?: string | null;
  ownerSessionId?: string | null;
  nowMs?: number;
  lastActivityAt?: number;
};

export type CandidatePruneResult = {
  pruned: Array<{ candidateId: string; status: CandidateStatus; reason: string }>;
  kept: number;
};

const DEFAULT_ACTIVE_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_DEPLOYED_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_SOFT_CAP_PER_LIVE_CODE_DIR = 10;

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function envInt(name: string): number | null {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function objectWithNormalizedLegacyFields(raw: unknown): Record<string, unknown> {
  const parsed = raw && typeof raw === "object" && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
  if (parsed.status === "open") {
    parsed.status = "active";
  }
  const createdAt =
    typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt)
      ? Math.max(0, Math.floor(parsed.createdAt))
      : 0;
  if (parsed.updatedAt === undefined) parsed.updatedAt = createdAt;
  if (parsed.lastActivityAt === undefined) parsed.lastActivityAt = createdAt;
  if (parsed.classification === undefined) parsed.classification = "pending";
  if (parsed.approvalId === undefined) parsed.approvalId = null;
  if (parsed.verificationFingerprint === undefined) parsed.verificationFingerprint = null;
  if (parsed.verifiedAt === undefined) parsed.verifiedAt = null;
  if (parsed.lastError === undefined) parsed.lastError = null;
  return parsed;
}

function isOpenCandidateStatus(status: CandidateStatus): boolean {
  return status !== "deployed" && status !== "rejected" && status !== "expired";
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
    if (code === "ENOENT") return false;
    throw err;
  }
}

function resolveCandidateGcPolicy(overrides: Partial<CandidateGcPolicy> = {}): CandidateGcPolicy {
  const activeTtlMs = overrides.activeTtlMs ?? envInt("NEXUS_CANDIDATE_ACTIVE_TTL_MS") ?? DEFAULT_ACTIVE_TTL_MS;
  const deployedRetentionMs =
    overrides.deployedRetentionMs ?? envInt("NEXUS_CANDIDATE_DEPLOYED_TTL_MS") ?? DEFAULT_DEPLOYED_RETENTION_MS;
  const softCapPerLiveCodeDir =
    overrides.softCapPerLiveCodeDir ??
    envInt("NEXUS_CANDIDATE_SOFT_CAP") ??
    DEFAULT_SOFT_CAP_PER_LIVE_CODE_DIR;

  return {
    activeTtlMs: Math.max(0, activeTtlMs),
    deployedRetentionMs: Math.max(0, deployedRetentionMs),
    softCapPerLiveCodeDir: Math.max(1, softCapPerLiveCodeDir),
  };
}

async function runGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr =
      typeof err === "object" && err !== null && "stderr" in err && typeof (err as { stderr?: unknown }).stderr === "string"
        ? (err as { stderr: string }).stderr.trim()
        : "";
    throw new Error(`git ${args.join(" ")} failed${cwd ? ` in ${cwd}` : ""}: ${message}${stderr ? `\n${stderr}` : ""}`);
  }
}

function withCandidatePermissionHint(err: unknown, targetDir: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  if (code === "EACCES" || code === "EPERM" || /\bEACCES\b|\bEPERM\b|permission denied/i.test(message)) {
    return new Error(
      `${message}\n` +
      `candidate workspace is not writable: ${targetDir}\n` +
      "Fix host ownership/permissions for the candidate root (typically <stateDir>/candidates) so the gateway runtime user can create and remove candidate workspaces.",
    );
  }
  return err instanceof Error ? err : new Error(message);
}

async function resolveGitHeadSha(repoDir: string): Promise<string> {
  const { stdout } = await runGit(["rev-parse", "HEAD"], repoDir);
  if (!stdout) throw new Error(`git rev-parse HEAD returned no output for ${repoDir}`);
  return stdout;
}

async function ensureCandidateGitExclude(repoDir: string, pattern: string): Promise<void> {
  const excludePath = path.join(repoDir, ".git", "info", "exclude");
  let existing = "";
  try {
    existing = await fs.readFile(excludePath, "utf8");
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
    if (code !== "ENOENT") throw err;
  }
  const normalized = existing.replace(/\r\n/g, "\n");
  const lines = new Set(
    normalized
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  if (lines.has(pattern)) return;
  const next = normalized.length > 0 && !normalized.endsWith("\n") ? `${normalized}\n${pattern}\n` : `${normalized}${pattern}\n`;
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, next, "utf8");
}

async function seedCandidateDependencies(liveCodeDir: string, repoDir: string): Promise<void> {
  const liveNodeModulesDir = path.join(liveCodeDir, "node_modules");
  const candidateNodeModulesDir = path.join(repoDir, "node_modules");
  if (!(await pathExists(liveNodeModulesDir))) return;
  if (await pathExists(candidateNodeModulesDir)) return;
  await ensureCandidateGitExclude(repoDir, "/node_modules");
  await fs.cp(liveNodeModulesDir, candidateNodeModulesDir, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
}

export function resolveCandidateDir(candidateRootDir: string, candidateId: string): string {
  return path.join(path.resolve(candidateRootDir), candidateId);
}

export function resolveCandidateRepoDir(candidateRootDir: string, candidateId: string): string {
  return path.join(resolveCandidateDir(candidateRootDir, candidateId), "repo");
}

export function resolveCandidateMetadataPath(candidateRootDir: string, candidateId: string): string {
  return path.join(resolveCandidateDir(candidateRootDir, candidateId), "candidate.json");
}

export async function createCandidate(params: CreateCandidateParams): Promise<CandidateRecord> {
  const liveCodeDir = path.resolve(params.liveCodeDir);
  const candidateRootDir = path.resolve(params.candidateRootDir);
  const candidateId = CandidateIdSchema.parse(params.candidateId?.trim() || `cand-${randomUUID()}`);
  const candidateDir = resolveCandidateDir(candidateRootDir, candidateId);
  const repoDir = resolveCandidateRepoDir(candidateRootDir, candidateId);
  const metadataPath = resolveCandidateMetadataPath(candidateRootDir, candidateId);
  const nowMs = Math.max(0, Math.floor(params.nowMs ?? Date.now()));
  const gcPolicy = resolveCandidateGcPolicy(params.gcPolicy);

  try {
    await fs.mkdir(candidateRootDir, { recursive: true });
  } catch (err) {
    throw withCandidatePermissionHint(err, candidateRootDir);
  }
  await pruneCandidates(candidateRootDir, { nowMs, gcPolicy });

  const candidates = await listCandidates(candidateRootDir);
  const openForLiveCodeDir = candidates.filter((candidate) => {
    return candidate.liveCodeDir === liveCodeDir && isOpenCandidateStatus(candidate.status);
  });
  if (openForLiveCodeDir.length >= gcPolicy.softCapPerLiveCodeDir) {
    throw new Error(
      `candidate soft cap exceeded for ${liveCodeDir}: ${openForLiveCodeDir.length} open candidate(s) ` +
      `(cap=${gcPolicy.softCapPerLiveCodeDir})`,
    );
  }

  const baseSha = await resolveGitHeadSha(liveCodeDir);
  try {
    await fs.mkdir(candidateDir, { recursive: false });
  } catch (err) {
    throw withCandidatePermissionHint(err, candidateDir);
  }

  try {
    await runGit(["clone", "--quiet", "--no-hardlinks", liveCodeDir, repoDir], candidateRootDir);
    await runGit(["checkout", "--quiet", baseSha], repoDir);
    await seedCandidateDependencies(liveCodeDir, repoDir);

    const record = CandidateRecordSchema.parse({
      candidateId,
      liveCodeDir,
      candidateDir,
      repoDir,
      metadataPath,
      baseSha,
      createdAt: nowMs,
      updatedAt: nowMs,
      lastActivityAt: nowMs,
      ownerRunId: params.ownerRunId ?? null,
      ownerSessionId: params.ownerSessionId ?? null,
      status: "active",
      verificationStatus: "pending",
      approvalStatus: "pending",
      classification: "pending",
      approvalId: null,
      verificationFingerprint: null,
      verifiedAt: null,
      lastError: null,
    });
    await fs.writeFile(metadataPath, formatJson(record), "utf8");
    return record;
  } catch (err) {
    await fs.rm(candidateDir, { recursive: true, force: true });
    throw withCandidatePermissionHint(err, candidateDir);
  }
}

export async function loadCandidate(candidateRootDir: string, candidateId: string): Promise<CandidateRecord> {
  const metadataPath = resolveCandidateMetadataPath(candidateRootDir, candidateId);
  const raw = await fs.readFile(metadataPath, "utf8");
  return CandidateRecordSchema.parse(objectWithNormalizedLegacyFields(JSON.parse(raw) as unknown));
}

export async function updateCandidate(
  candidateRootDir: string,
  candidateId: string,
  patch: UpdateCandidatePatch,
): Promise<CandidateRecord> {
  const existing = await loadCandidate(candidateRootDir, candidateId);
  const nowMs = Math.max(0, Math.floor(patch.nowMs ?? Date.now()));
  const next = CandidateRecordSchema.parse({
    ...existing,
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.verificationStatus !== undefined ? { verificationStatus: patch.verificationStatus } : {}),
    ...(patch.approvalStatus !== undefined ? { approvalStatus: patch.approvalStatus } : {}),
    ...(patch.classification !== undefined ? { classification: patch.classification } : {}),
    ...(patch.approvalId !== undefined ? { approvalId: patch.approvalId } : {}),
    ...(patch.verificationFingerprint !== undefined ? { verificationFingerprint: patch.verificationFingerprint } : {}),
    ...(patch.verifiedAt !== undefined ? { verifiedAt: patch.verifiedAt } : {}),
    ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
    ...(patch.ownerRunId !== undefined ? { ownerRunId: patch.ownerRunId } : {}),
    ...(patch.ownerSessionId !== undefined ? { ownerSessionId: patch.ownerSessionId } : {}),
    updatedAt: nowMs,
    lastActivityAt:
      patch.lastActivityAt !== undefined
        ? Math.max(0, Math.floor(patch.lastActivityAt))
        : nowMs,
  });
  await fs.writeFile(existing.metadataPath, formatJson(next), "utf8");
  return next;
}

export async function touchCandidate(candidateRootDir: string, candidateId: string, nowMs?: number): Promise<CandidateRecord> {
  return await updateCandidate(candidateRootDir, candidateId, { nowMs });
}

export async function listCandidates(candidateRootDir: string): Promise<CandidateRecord[]> {
  const root = path.resolve(candidateRootDir);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: string }).code : undefined;
    if (code === "ENOENT") return [];
    throw err;
  }

  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => await loadCandidate(root, entry.name)),
  );
  return records.sort((left, right) => left.createdAt - right.createdAt);
}

export async function deleteCandidate(candidateRootDir: string, candidateId: string): Promise<void> {
  await fs.rm(resolveCandidateDir(candidateRootDir, candidateId), { recursive: true, force: true });
}

export async function pruneCandidates(
  candidateRootDir: string,
  params: {
    nowMs?: number;
    gcPolicy?: Partial<CandidateGcPolicy>;
  } = {},
): Promise<CandidatePruneResult> {
  const root = path.resolve(candidateRootDir);
  const nowMs = Math.max(0, Math.floor(params.nowMs ?? Date.now()));
  const gcPolicy = resolveCandidateGcPolicy(params.gcPolicy);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: string }).code : undefined;
    if (code === "ENOENT") return { pruned: [], kept: 0 };
    throw err;
  }

  const pruned: CandidatePruneResult["pruned"] = [];
  let kept = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidateId = entry.name;
    let record: CandidateRecord;
    try {
      record = await loadCandidate(root, candidateId);
    } catch {
      await deleteCandidate(root, candidateId);
      pruned.push({ candidateId, status: "expired", reason: "invalid_metadata" });
      continue;
    }

    const lastActivityAt = Math.max(record.lastActivityAt, record.updatedAt, record.createdAt);
    const ageMs = Math.max(0, nowMs - lastActivityAt);
    let pruneReason: string | null = null;

    if (record.status === "rejected" || record.status === "expired") {
      pruneReason = record.status;
    } else if (record.status === "deployed") {
      if (ageMs > gcPolicy.deployedRetentionMs) {
        pruneReason = "rollback_window_expired";
      }
    } else if (ageMs > gcPolicy.activeTtlMs) {
      pruneReason = "stale";
    }

    if (!pruneReason) {
      kept += 1;
      continue;
    }

    await deleteCandidate(root, candidateId);
    pruned.push({ candidateId, status: record.status, reason: pruneReason });
  }

  return { pruned, kept };
}
