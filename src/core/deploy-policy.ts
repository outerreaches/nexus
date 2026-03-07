import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Extensions that never require a deploy (documentation, assets, etc.) */
const NON_DEPLOYABLE_EXTS = new Set([
  ".md", ".txt", ".log", ".csv",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp",
  ".mp3", ".mp4", ".wav", ".webm",
  ".pdf", ".doc", ".docx",
]);

const AUTO_DEPLOYABLE_INTAKE_ROOT = "src/data-intake/sources/";
const AUTO_DEPLOYABLE_INTAKE_MANIFEST = "src/data-intake/generated-sources.ts";

export type DeployPolicy = "none" | "intake_auto_deploy" | "approval_required";

export type DeployChangeInspection = {
  all: string[];
  deployable: string[];
  skipped: string[];
  intakeDeployable: string[];
  approvalRequired: string[];
  intakeCompatibilityIssues: string[];
  policy: DeployPolicy;
  fingerprint: string | null;
  gitStatusError?: string;
};

type GitStatusEntry = {
  status: string;
  path: string;
  originalPath?: string;
};

function normalizeGitRelativePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  let normalized = trimmed.replaceAll("\\", "/");
  if (
    normalized.length >= 2 &&
    normalized.startsWith("\"") &&
    normalized.endsWith("\"")
  ) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/^\.?\//, "");
}

function parseGitStatusEntries(raw: Buffer): GitStatusEntry[] {
  const fields = raw.toString("utf8").split("\0");
  const seen = new Set<string>();
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index] ?? "";
    if (!entry) continue;
    const status = entry.slice(0, 2);
    let relativePath = entry.length > 3 ? entry.slice(3) : "";
    let originalPath: string | undefined;
    if (!relativePath) continue;
    if (status.includes("R") || status.includes("C")) {
      const renamedPath = fields[index + 1] ?? "";
      if (renamedPath) {
        originalPath = relativePath;
        relativePath = renamedPath;
        index += 1;
      }
    }
    const normalized = normalizeGitRelativePath(relativePath);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    entries.push({
      status,
      path: normalized,
      ...(originalPath ? { originalPath: normalizeGitRelativePath(originalPath) } : {}),
    });
  }
  return entries;
}

function parseGitStatusPaths(raw: Buffer): string[] {
  return parseGitStatusEntries(raw).map((entry) => entry.path);
}

function listUntrackedPaths(codeDir: string): string[] {
  const raw = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: codeDir,
    timeout: 10_000,
  });
  return raw
    .toString("utf8")
    .split("\0")
    .map((entry) => normalizeGitRelativePath(entry))
    .filter(Boolean);
}

function computeWorktreeFingerprint(codeDir: string, statusBuffer: Buffer): string | null {
  try {
    const hash = createHash("sha256");
    hash.update(statusBuffer);

    const diffBuffer = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], {
      cwd: codeDir,
      timeout: 10_000,
    });
    hash.update(diffBuffer);

    const untrackedPaths = listUntrackedPaths(codeDir).sort((left, right) => left.localeCompare(right));
    for (const relativePath of untrackedPaths) {
      hash.update("\0untracked\0");
      hash.update(relativePath);
      hash.update("\0");
      hash.update(readFileSync(path.join(codeDir, relativePath)));
    }

    return hash.digest("hex");
  } catch {
    return null;
  }
}

function isNonDeployablePath(relativePath: string): boolean {
  const normalized = normalizeGitRelativePath(relativePath);
  const ext = path.posix.extname(normalized).toLowerCase();
  return NON_DEPLOYABLE_EXTS.has(ext);
}

export function isAutoDeployableIntakePath(relativePath: string): boolean {
  const normalized = normalizeGitRelativePath(relativePath);
  return normalized === AUTO_DEPLOYABLE_INTAKE_MANIFEST || normalized.startsWith(AUTO_DEPLOYABLE_INTAKE_ROOT);
}

function extractDataSourceIdFromText(content: string): string | null {
  const match = content.match(/\bid\s*:\s*["'`]([^"'`]+)["'`]/);
  return match?.[1]?.trim() || null;
}

function readHeadVersion(codeDir: string, relativePath: string): string | null {
  try {
    return execFileSync("git", ["show", `HEAD:${relativePath}`], {
      cwd: codeDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function readWorkingTreeDataSourceId(codeDir: string, relativePath: string): string | null {
  const absolutePath = path.join(codeDir, relativePath);
  if (!existsSync(absolutePath)) return null;
  try {
    return extractDataSourceIdFromText(readFileSync(absolutePath, "utf8"));
  } catch {
    return null;
  }
}

function collectCandidateSourceIdDuplicates(codeDir: string, changedPaths: Set<string>): string[] {
  const sourceRoot = path.join(codeDir, "src", "data-intake", "sources");
  if (!existsSync(sourceRoot)) return [];

  const byId = new Map<string, string[]>();
  const stack = [sourceRoot];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(?:ts|tsx|mts|cts)$/i.test(entry.name)) continue;
      if (entry.name === "index.ts") continue;
      const relativePath = normalizeGitRelativePath(path.relative(codeDir, absolutePath));
      const sourceId = readWorkingTreeDataSourceId(codeDir, relativePath);
      if (!sourceId) continue;
      const paths = byId.get(sourceId) ?? [];
      paths.push(relativePath);
      byId.set(sourceId, paths);
    }
  }

  const issues: string[] = [];
  for (const [sourceId, paths] of byId.entries()) {
    if (paths.length < 2) continue;
    if (!paths.some((entry) => changedPaths.has(entry))) continue;
    issues.push(`duplicate source.id '${sourceId}' declared in ${paths.sort().join(", ")}`);
  }
  return issues;
}

function collectIntakeCompatibilityIssues(codeDir: string, entries: GitStatusEntry[]): string[] {
  const issues: string[] = [];
  const changedPaths = new Set(
    entries
      .filter((entry) => entry.path.startsWith(AUTO_DEPLOYABLE_INTAKE_ROOT))
      .map((entry) => entry.path),
  );
  const changedIntakeSourceEntries = entries.filter((entry) => {
    return entry.path.startsWith(AUTO_DEPLOYABLE_INTAKE_ROOT);
  });
  const manifestChanged = entries.some((entry) => {
    return entry.path === AUTO_DEPLOYABLE_INTAKE_MANIFEST || entry.originalPath === AUTO_DEPLOYABLE_INTAKE_MANIFEST;
  });

  if (manifestChanged && changedIntakeSourceEntries.length === 0) {
    issues.push("generated intake manifest changed without a corresponding intake source file change");
  }

  for (const entry of changedIntakeSourceEntries) {
    if (entry.originalPath && entry.originalPath !== entry.path) {
      issues.push(`intake source renamed: ${entry.originalPath} -> ${entry.path}`);
      continue;
    }

    const currentId = readWorkingTreeDataSourceId(codeDir, entry.path);
    const headSource = readHeadVersion(codeDir, entry.path);
    const headId = headSource ? extractDataSourceIdFromText(headSource) : null;
    const deletedInWorktree = !existsSync(path.join(codeDir, entry.path));
    const status = entry.status.toUpperCase();

    if (deletedInWorktree || status.includes("D")) {
      issues.push(`intake source removed: ${entry.path}`);
      continue;
    }
    if (!currentId) {
      issues.push(`could not determine source.id for ${entry.path}`);
      continue;
    }
    if (headSource && !headId) {
      issues.push(`could not determine existing source.id for ${entry.path}`);
      continue;
    }
    if (headId && headId !== currentId) {
      issues.push(`source.id changed for ${entry.path}: ${headId} -> ${currentId}`);
    }
  }

  issues.push(...collectCandidateSourceIdDuplicates(codeDir, changedPaths));
  return Array.from(new Set(issues));
}

export function inspectDeployWorktree(codeDir: string): DeployChangeInspection {
  let statusBuffer: Buffer;
  try {
    statusBuffer = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
      cwd: codeDir,
      timeout: 10_000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      all: ["(git status failed)"],
      deployable: ["(git status failed)"],
      skipped: [],
      intakeDeployable: [],
      approvalRequired: ["(git status failed)"],
      intakeCompatibilityIssues: [],
      policy: "approval_required",
      fingerprint: null,
      gitStatusError: message,
    };
  }

  const all = parseGitStatusPaths(statusBuffer);
  if (all.length === 0) {
    return {
      all,
      deployable: [],
      skipped: [],
      intakeDeployable: [],
      approvalRequired: [],
      intakeCompatibilityIssues: [],
      policy: "none",
      fingerprint: null,
    };
  }

  const deployable: string[] = [];
  const skipped: string[] = [];
  const intakeDeployable: string[] = [];
  const approvalRequired: string[] = [];
  for (const relativePath of all) {
    if (isNonDeployablePath(relativePath)) {
      skipped.push(relativePath);
      continue;
    }
    deployable.push(relativePath);
    if (isAutoDeployableIntakePath(relativePath)) {
      intakeDeployable.push(relativePath);
      continue;
    }
    approvalRequired.push(relativePath);
  }

  const intakeCompatibilityIssues =
    deployable.length > 0 && approvalRequired.length === 0
      ? collectIntakeCompatibilityIssues(codeDir, parseGitStatusEntries(statusBuffer))
      : [];

  const policy: DeployPolicy =
    deployable.length === 0
      ? "none"
      : approvalRequired.length === 0 && intakeCompatibilityIssues.length === 0
        ? "intake_auto_deploy"
        : "approval_required";

  return {
    all,
    deployable,
    skipped,
    intakeDeployable,
    approvalRequired,
    intakeCompatibilityIssues,
    policy,
    fingerprint: computeWorktreeFingerprint(codeDir, statusBuffer),
  };
}
