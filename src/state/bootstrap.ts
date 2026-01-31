import fs from "node:fs/promises";

import { resolveRuntimePaths } from "./paths.js";
import type { NexusConfig } from "./config.js";

export async function bootstrapState(config: NexusConfig): Promise<{ stateDir: string; workspaceDir: string }> {
  const paths = await resolveRuntimePaths(config);
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.mkdir(paths.workspaceDir, { recursive: true });

  // Note: Personalization files (SOUL.md, IDENTITY.md, etc.) are created
  // by the onboarding process, not here. This just ensures directories exist.

  return { stateDir: paths.stateDir, workspaceDir: paths.workspaceDir };
}
