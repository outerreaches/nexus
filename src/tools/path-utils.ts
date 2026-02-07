import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

function resolveViaExistingParent(targetPath: string): string {
  let cursor = path.resolve(targetPath);
  const tail: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    tail.unshift(path.basename(cursor));
    cursor = parent;
  }
  const base = existsSync(cursor) ? realpathSync.native(cursor) : path.resolve(cursor);
  return tail.length > 0 ? path.join(base, ...tail) : base;
}

function resolveRealPath(targetPath: string): string {
  const absolute = path.resolve(targetPath);
  if (existsSync(absolute)) {
    return realpathSync.native(absolute);
  }
  return resolveViaExistingParent(absolute);
}

export function resolveWithinRoots(params: { inputPath: string; roots: string[]; defaultRoot: string }): string {
  const raw = params.inputPath.trim();
  const candidate = path.isAbsolute(raw) ? raw : path.join(params.defaultRoot, raw);
  const normalized = resolveRealPath(candidate);

  for (const root of params.roots) {
    const normalizedRoot = resolveRealPath(root);
    const rel = path.relative(normalizedRoot, normalized);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return normalized;
  }

  throw new Error(`Path is outside allowed roots: ${raw}`);
}
