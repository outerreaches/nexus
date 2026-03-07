import path from "node:path";

import { CandidateBindingSchema, createCandidate, touchCandidate } from "../state/candidates.js";
import type { ToolContext } from "./tools.js";

type RunTaskType = "plan" | "review" | "walkthrough" | "write" | null | undefined;
type RunExecutionTarget = { target: "local" } | { target: "node"; nodeId: string } | undefined;

const READ_ONLY_CODER_TASK_TYPES = new Set<Exclude<RunTaskType, "write" | null | undefined>>([
  "plan",
  "review",
  "walkthrough",
]);

function normalizeLiveCodeDir(ctx: ToolContext): string {
  return path.resolve(ctx.liveCodeDir ?? ctx.codeDir);
}

function normalizeCandidateRootDir(ctx: ToolContext): string {
  return path.resolve(ctx.candidateRootDir ?? path.join(ctx.stateDir, "candidates"));
}

function withNormalizedCodeRoots(ctx: ToolContext): ToolContext {
  const liveCodeDir = normalizeLiveCodeDir(ctx);
  const candidateRootDir = normalizeCandidateRootDir(ctx);
  const candidate = ctx.candidate ? CandidateBindingSchema.parse(ctx.candidate) : undefined;
  return {
    ...ctx,
    codeDir: candidate ? path.resolve(candidate.repoDir) : liveCodeDir,
    liveCodeDir,
    candidateRootDir,
    candidate,
  };
}

function shouldCreateCandidate(params: {
  presetName?: string;
  taskType?: RunTaskType;
  executionTarget?: RunExecutionTarget;
}): boolean {
  if (params.executionTarget?.target === "node") return false;
  if ((params.presetName ?? "").trim() !== "coder") return false;
  if (params.taskType && params.taskType !== "write" && READ_ONLY_CODER_TASK_TYPES.has(params.taskType)) return false;
  return true;
}

export async function resolveRunCodeContext(params: {
  baseContext: ToolContext;
  presetName?: string;
  taskType?: RunTaskType;
  runId?: string | null;
  sessionId?: string | null;
  executionTarget?: RunExecutionTarget;
  log?: (line: string) => void;
}): Promise<ToolContext> {
  const normalized = withNormalizedCodeRoots(params.baseContext);
  if (normalized.candidate) {
    if (normalized.candidateRootDir) {
      await touchCandidate(normalized.candidateRootDir, normalized.candidate.candidateId, normalized.nowMs());
    }
    params.log?.(
      `run_code_context: reusing candidate id=${normalized.candidate.candidateId} baseSha=${normalized.candidate.baseSha}`,
    );
    return normalized;
  }

  if (
    !shouldCreateCandidate({
      presetName: params.presetName,
      taskType: params.taskType,
      executionTarget: params.executionTarget,
    })
  ) {
    return normalized;
  }

  const record = await createCandidate({
    liveCodeDir: normalized.liveCodeDir ?? normalized.codeDir,
    candidateRootDir: normalized.candidateRootDir ?? path.join(normalized.stateDir, "candidates"),
    ownerRunId: params.runId ?? null,
    ownerSessionId: params.sessionId ?? null,
    nowMs: normalized.nowMs(),
  });

  params.log?.(
    `run_code_context: created candidate id=${record.candidateId} baseSha=${record.baseSha} repo=${record.repoDir}`,
  );

  return {
    ...normalized,
    codeDir: record.repoDir,
    candidate: {
      candidateId: record.candidateId,
      baseSha: record.baseSha,
      repoDir: record.repoDir,
    },
  };
}
