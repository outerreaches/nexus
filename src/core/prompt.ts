import fs from "node:fs/promises";
import path from "node:path";

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function buildSystemPrompt(params: {
  workspaceDir: string;
  agentId?: string;
}): Promise<string> {
  const rootSoul = await readIfExists(path.join(params.workspaceDir, "SOUL.md"));
  const rootAgents = await readIfExists(path.join(params.workspaceDir, "AGENTS.md"));

  const agentSoul = params.agentId
    ? await readIfExists(path.join(params.workspaceDir, "agents", params.agentId, "SOUL.md"))
    : null;
  const agentAgents = params.agentId
    ? await readIfExists(path.join(params.workspaceDir, "agents", params.agentId, "AGENTS.md"))
    : null;

  const parts: string[] = [];
  if (agentSoul) parts.push(agentSoul.trim());
  else if (rootSoul) parts.push(rootSoul.trim());

  if (agentAgents) parts.push(agentAgents.trim());
  else if (rootAgents) parts.push(rootAgents.trim());

  parts.push(
    [
      "## Runtime Notes",
      "- You may call tools to read/write files, browse, and automate tasks.",
      "- When you change your own prompts/tools, leave a short note in `NOTES.md`.",
    ].join("\n"),
  );

  return parts.filter(Boolean).join("\n\n");
}

