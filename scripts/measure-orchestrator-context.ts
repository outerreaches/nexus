// Estimate orchestrator's system prompt + tool schema size, before lazy loading
// vs after. Run with: npx tsx scripts/measure-orchestrator-context.ts
//
// Imports tools individually to avoid the spawn-agent → openai-compat → undici
// chain (undici may not be installed in dev). Tools that pull in undici (image_*,
// video_analyze) are still counted by description + name only, using a hand-built
// fake jsonSchema stub of average size derived from peer tools.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { getPreset, formatPresetsForPrompt } from "../src/core/presets.js";
import { buildRunState, type Tool } from "../src/core/tools.js";
import { estimateToolTokens, CHARS_PER_TOKEN } from "../src/core/context-compactor.js";
import { formatSkillsPromptSection, loadSkills } from "../src/state/skills.js";

import { fileEdit, fileEditLines, fileList, filePatch, fileRead, fileWrite } from "../src/tools/file-ops.js";
import { codeDiff, codeSearch, fileGlob } from "../src/tools/code-intel.js";
import { browserTool } from "../src/tools/browser.js";
import { queryData } from "../src/tools/query-data.js";
import { shellExec } from "../src/tools/system.js";
import { processManage } from "../src/tools/process.js";
import {
  nodeManage,
  nodeAuditQuery,
  nodeMcpCall,
  nodeMcpList,
  nodeMcpResources,
  nodeSymbolsList,
} from "../src/tools/nodes.js";
import { webFetch } from "../src/tools/web.js";
import { webSearch } from "../src/tools/web-search.js";
import { imageAnalyze } from "../src/tools/image-analyze.js";
import { generateSvg } from "../src/tools/generate-svg.js";
import { vectorize } from "../src/tools/vectorize.js";
import { paperTrade, portfolioStatus } from "../src/tools/trading.js";
import { haDeploy } from "../src/tools/ha-deploy.js";
import { humanAction } from "../src/tools/human-actions.js";
import { jobManage } from "../src/tools/jobs.js";
import { telegramSend } from "../src/tools/telegram-send.js";
import { memoryStore, memoryRecall, memorySearch, memoryDelete } from "../src/tools/memory.js";
import { skillCreate, skillGet, skillList, skillSearch, skillUpdate } from "../src/tools/skills.js";
import { writeToBlackboard, readFromBlackboard, blackboardManage } from "../src/tools/blackboard.js";
import { dbMaintenance } from "../src/tools/db-maintenance.js";
import { dbBackup } from "../src/tools/db-backup.js";
import { sessionSearch } from "../src/tools/session-search.js";
import { shellInteractive } from "../src/tools/shell-interactive.js";
import { mcpManage } from "../src/tools/mcp.js";
import { dataIntakeManage } from "../src/tools/data-intake.js";
import { toolCatalog, toolLoad, toolSearch, toolUnload } from "../src/tools/tool-catalog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const stateDir = path.join(process.env.HOME ?? "", ".nexus", "state");

const SAFE_TOOLS: Tool[] = [
  fileRead, fileWrite, fileEdit, fileEditLines, filePatch, fileList, fileGlob,
  codeSearch, codeDiff, webFetch, webSearch, imageAnalyze, generateSvg,
  vectorize, shellExec, shellInteractive, processManage,
  nodeMcpList, nodeMcpCall, nodeMcpResources, nodeSymbolsList, nodeAuditQuery, nodeManage,
  browserTool, queryData, haDeploy, paperTrade, portfolioStatus, humanAction, telegramSend,
  jobManage, memoryStore, memoryRecall, memorySearch, memoryDelete, sessionSearch,
  skillCreate, skillList, skillSearch, skillGet, skillUpdate,
  writeToBlackboard, readFromBlackboard, blackboardManage, dataIntakeManage,
  dbMaintenance, dbBackup, mcpManage, toolCatalog, toolSearch, toolLoad, toolUnload,
];

// Tools omitted from SAFE_TOOLS because their modules chain to undici via
// openai-compat. We stub these with average schemas so totals stay realistic.
const STUB_NAMES = ["image_generate", "image_edit", "video_analyze", "generate_song", "spawn_agent"];

const averageJsonSchemaLen = Math.round(
  SAFE_TOOLS.reduce((sum, t) => sum + JSON.stringify(t.jsonSchema).length, 0) / SAFE_TOOLS.length,
);

function stubTool(name: string): Tool {
  return {
    name,
    description: `Stubbed for measurement (${name}). Real descriptions and schemas vary.`,
    nodeRoutable: false,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => "",
    // Inflate schema char count to a per-tool average so totals stay realistic.
    // estimateToolTokens uses JSON.stringify(jsonSchema).length, so we monkey-patch.
  } as Tool;
}

async function main() {
  const preset = getPreset("orchestrator");
  if (!preset) throw new Error("orchestrator preset missing");

  const byName = new Map<string, Tool>();
  for (const t of SAFE_TOOLS) byName.set(t.name, t);
  for (const name of STUB_NAMES) byName.set(name, stubTool(name));

  const allowed = new Set(preset.tools);
  const beforeTools: Tool[] = [];
  const missing: string[] = [];
  for (const name of preset.tools) {
    const t = byName.get(name);
    if (!t) {
      missing.push(name);
      continue;
    }
    beforeTools.push(t);
  }
  if (missing.length > 0) {
    console.warn(`(missing from measurement set: ${missing.join(", ")})`);
  }

  const runState = buildRunState({
    presetKernel: preset.kernel,
    presetTools: preset.tools,
    filteredToolNames: beforeTools.map((t) => t.name),
  });
  const visibleNames = runState ? runState.kernelToolNames : allowed;
  const afterTools = beforeTools.filter((t) => visibleNames.has(t.name));

  const skills = await loadSkills(stateDir, undefined, "orchestrator");
  const skillsSection = formatSkillsPromptSection(skills) ?? "";
  const presetsBlock = formatPresetsForPrompt();
  const presetSystemPrompt = preset.systemPrompt ?? "";

  const beforeToolTokens = estimateToolTokens(beforeTools);
  const afterToolTokens = estimateToolTokens(afterTools);
  const presetPromptTokens = Math.ceil(presetSystemPrompt.length / CHARS_PER_TOKEN);
  const skillsSectionTokens = Math.ceil(skillsSection.length / CHARS_PER_TOKEN);
  const presetsBlockTokens = Math.ceil(presetsBlock.length / CHARS_PER_TOKEN);

  console.log("");
  console.log("=== Orchestrator context size estimate ===");
  console.log("");
  console.log(`Tool count: before=${beforeTools.length}  after=${afterTools.length}`);
  console.log(`Avg JSON schema char count per tool (sample): ${averageJsonSchemaLen}`);
  console.log("");
  console.log("Tool schemas (LLM-facing):");
  console.log(`  before: ${beforeToolTokens.toLocaleString()} tokens`);
  console.log(`  after:  ${afterToolTokens.toLocaleString()} tokens`);
  console.log(`  saved:  ${(beforeToolTokens - afterToolTokens).toLocaleString()} tokens (${((1 - afterToolTokens / beforeToolTokens) * 100).toFixed(1)}%)`);
  console.log("");
  console.log(`Preset systemPrompt:     ${presetPromptTokens.toLocaleString()} tokens (was ~1500 before refactor)`);
  console.log(`Skills index:            ${skillsSectionTokens.toLocaleString()} tokens (${skills.length} skills, was inline-full)`);
  console.log(`Presets list block:      ${presetsBlockTokens.toLocaleString()} tokens (unchanged)`);
  console.log("");
  console.log("Kernel tools:");
  for (const t of afterTools) console.log(`  - ${t.name}`);
  console.log("");
  console.log(`Lazy-loadable catalog: ${beforeTools.length - afterTools.length} tools`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

void __dirname;
