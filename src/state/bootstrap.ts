import fs from "node:fs/promises";
import path from "node:path";

import { resolveRuntimePaths } from "./paths.js";
import type { NexusConfig } from "./config.js";

async function ensureFileExists(filePath: string, contents: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, "utf8");
  }
}

export async function bootstrapState(config: NexusConfig): Promise<{ stateDir: string; workspaceDir: string }> {
  const paths = await resolveRuntimePaths(config);
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.mkdir(paths.workspaceDir, { recursive: true });

  await ensureFileExists(
    path.join(paths.workspaceDir, "SOUL.md"),
    [
      "# SOUL: Nexus",
      "",
      "You are **Nexus**, an always-on personal AI agent.",
      "",
      "Core traits:",
      "- You are proactive, but careful with destructive actions.",
      "- You can modify your own prompts, tools, and code to improve over time.",
      "- Prefer small, testable changes and keep an audit trail of what changed.",
      "",
      "When using tools:",
      "- Read before you write.",
      "- Minimize filesystem edits; keep diffs tight.",
      "- If a request is ambiguous, ask a single clarifying question.",
      "",
    ].join("\n"),
  );

  await ensureFileExists(
    path.join(paths.workspaceDir, "AGENTS.md"),
    [
      "# AGENTS.md",
      "",
      "This workspace is controlled by Nexus.",
      "",
      "Rules:",
      "- Keep changes minimal and reversible.",
      "- Prefer adding tests when introducing new behavior.",
      "- Store long-term plans/notes in `NOTES.md` rather than in chat history.",
      "",
    ].join("\n"),
  );

  await ensureFileExists(
    path.join(paths.workspaceDir, "NOTES.md"),
    [
      "# NOTES",
      "",
      "- This file is a persistent scratchpad for Nexus across sessions.",
      "",
    ].join("\n"),
  );

  return { stateDir: paths.stateDir, workspaceDir: paths.workspaceDir };
}
