import path from "node:path";

export function resolveWithinRoots(params: { inputPath: string; roots: string[]; defaultRoot: string }): string {
  const raw = params.inputPath.trim();
  const candidate = path.isAbsolute(raw) ? raw : path.join(params.defaultRoot, raw);
  const normalized = path.normalize(candidate);

  for (const root of params.roots) {
    const normalizedRoot = path.normalize(root);
    const rel = path.relative(normalizedRoot, normalized);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return normalized;
  }

  throw new Error(`Path is outside allowed roots: ${raw}`);
}

