import fs from "node:fs/promises";
import path from "node:path";

const MANAGED_BLACKBOARD_ATTACHMENT_SUBDIRS = ["telegram-files"];

type AttachmentRow = {
  attachments_json?: unknown;
};

function safeParseAttachments(raw: unknown): Array<{ path?: unknown }> {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as Array<{ path?: unknown }>;
  } catch {
    return [];
  }
}

function isUnderDir(candidate: string, dir: string): boolean {
  return candidate === dir || candidate.startsWith(`${dir}${path.sep}`);
}

function getManagedRoots(stateDir: string): string[] {
  const resolvedStateDir = path.resolve(stateDir);
  return MANAGED_BLACKBOARD_ATTACHMENT_SUBDIRS.map((subdir) => path.join(resolvedStateDir, subdir));
}

function isManagedAttachmentPath(filePath: string, managedRoots: string[]): boolean {
  return managedRoots.some((root) => isUnderDir(filePath, root));
}

async function removeEmptyManagedParents(filePath: string, managedRoots: string[]): Promise<void> {
  const normalizedRoots = managedRoots.map((root) => path.resolve(root));
  let current = path.dirname(path.resolve(filePath));
  while (current.length > 1) {
    const parentManagedRoot = normalizedRoots.find((root) => isUnderDir(current, root));
    if (!parentManagedRoot || current === parentManagedRoot) return;
    try {
      await fs.rmdir(current);
      current = path.dirname(current);
    } catch {
      return;
    }
  }
}

export function collectManagedBlackboardAttachmentPaths(stateDir: string, rows: AttachmentRow[]): string[] {
  const managedRoots = getManagedRoots(stateDir);
  const out = new Set<string>();
  for (const row of rows) {
    const attachments = safeParseAttachments(row.attachments_json);
    for (const attachment of attachments) {
      if (typeof attachment.path !== "string" || attachment.path.trim().length === 0) continue;
      const resolved = path.resolve(attachment.path);
      if (!isManagedAttachmentPath(resolved, managedRoots)) continue;
      out.add(resolved);
    }
  }
  return Array.from(out);
}

export async function cleanupManagedBlackboardAttachments(params: {
  stateDir: string;
  rows: AttachmentRow[];
}): Promise<{ removed: number; failed: number }> {
  const managedRoots = getManagedRoots(params.stateDir);
  const paths = collectManagedBlackboardAttachmentPaths(params.stateDir, params.rows);
  let removed = 0;
  let failed = 0;
  for (const filePath of paths) {
    if (!isManagedAttachmentPath(filePath, managedRoots)) continue;
    try {
      await fs.unlink(filePath);
      removed += 1;
      await removeEmptyManagedParents(filePath, managedRoots);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") continue;
      failed += 1;
    }
  }
  return { removed, failed };
}

