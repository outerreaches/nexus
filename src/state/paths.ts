import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { inferCodeDir } from "./code-dir.js";

export const RuntimePathsSchema = z.object({
  stateDir: z.string(),
  workspaceDir: z.string(),
  codeDir: z.string(),
  dbPath: z.string(),
});

export type RuntimePaths = z.infer<typeof RuntimePathsSchema>;

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function getDefaultStateDir(): string {
  return expandHome(process.env.NEXUS_STATE_DIR ?? path.join(os.homedir(), ".nexus"));
}

export function getDefaultConfigPath(): string {
  return expandHome(process.env.NEXUS_CONFIG_PATH ?? path.join(getDefaultStateDir(), "nexus.json"));
}

export async function resolveRuntimePaths(config: {
  stateDir?: string;
  workspaceDir?: string;
  codeDir?: string;
}): Promise<RuntimePaths> {
  const stateDir = path.resolve(expandHome(config.stateDir ?? getDefaultStateDir()));
  const workspaceDefault = process.env.NEXUS_WORKSPACE_DIR ?? path.join(stateDir, "workspace");
  const workspaceDir = path.resolve(expandHome(config.workspaceDir ?? workspaceDefault));
  const codeDirRaw = config.codeDir;
  const codeDirDefault = process.env.NEXUS_CODE_DIR ?? (await inferCodeDir());
  const codeDir =
    codeDirRaw && /^\$\{[A-Z0-9_]+\}$/.test(codeDirRaw)
      ? path.resolve(expandHome(codeDirDefault))
      : path.resolve(expandHome(codeDirRaw ?? codeDirDefault));
  const dbPath = path.join(stateDir, "nexus.db");
  return RuntimePathsSchema.parse({ stateDir, workspaceDir, codeDir, dbPath });
}
