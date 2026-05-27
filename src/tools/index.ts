import type { Tool } from "../core/tools.js";

import { fileEdit, fileEditLines, fileList, filePatch, fileRead, fileWrite } from "./file-ops.js";
import { codeDiff, codeSearch, fileGlob } from "./code-intel.js";
import { browserTool } from "./browser.js";
import { queryData } from "./query-data.js";
import { shellExec } from "./system.js";
import { processManage } from "./process.js";
import {
  nodeManage,
  nodeAuditQuery,
  nodeMcpCall,
  nodeMcpList,
  nodeMcpResources,
  nodeSymbolsList,
} from "./nodes.js";
import { webFetch } from "./web.js";
import { webSearch } from "./web-search.js";
import { imageAnalyze } from "./image-analyze.js";
import { imageGenerate } from "./image-generate.js";
import { imageEdit } from "./image-edit.js";
import { generateSvg } from "./generate-svg.js";
import { vectorize } from "./vectorize.js";
import { videoAnalyze } from "./video-analyze.js";
import { paperTrade, portfolioStatus } from "./trading.js";
import { haDeploy } from "./ha-deploy.js";
import { humanAction } from "./human-actions.js";
import { jobManage } from "./jobs.js";
import { telegramSend } from "./telegram-send.js";
import { memoryStore, memoryRecall, memorySearch, memoryDelete } from "./memory.js";
import { skillCreate, skillGet, skillList, skillSearch, skillUpdate } from "./skills.js";
import { writeToBlackboard, readFromBlackboard, blackboardManage } from "./blackboard.js";
import { dbMaintenance } from "./db-maintenance.js";
import { dbBackup } from "./db-backup.js";
import { spawnAgent } from "./spawn-agent.js";
import { sessionSearch } from "./session-search.js";
import { shellInteractive } from "./shell-interactive.js";
import { mcpManage } from "./mcp.js";
import { dataIntakeManage } from "./data-intake.js";
import { toolCatalog, toolLoad, toolSearch, toolUnload } from "./tool-catalog.js";
import { GENERATED_RUNTIME_TOOLS } from "./generated-runtime-tools.js";

export function getBuiltInTools(): Tool[] {
  return [
    fileRead,
    fileWrite,
    fileEdit,
    fileEditLines,
    filePatch,
    fileList,
    fileGlob,
    codeSearch,
    codeDiff,
    webFetch,
    webSearch,
    imageAnalyze,
    imageGenerate,
    imageEdit,
    generateSvg,
    vectorize,
    videoAnalyze,
    shellExec,
    shellInteractive,
    processManage,
    nodeMcpList,
    nodeMcpCall,
    nodeMcpResources,
    nodeSymbolsList,
    nodeAuditQuery,
    nodeManage,
    browserTool,
    queryData,
    haDeploy,
    paperTrade,
    portfolioStatus,
    humanAction,
    telegramSend,
    jobManage,
    memoryStore,
    memoryRecall,
    memorySearch,
    memoryDelete,
    sessionSearch,
    skillCreate,
    skillList,
    skillSearch,
    skillGet,
    skillUpdate,
    writeToBlackboard,
    readFromBlackboard,
    blackboardManage,
    dataIntakeManage,
    spawnAgent,
    dbMaintenance,
    dbBackup,
    mcpManage,
    toolCatalog,
    toolSearch,
    toolLoad,
    toolUnload,
    ...GENERATED_RUNTIME_TOOLS,
  ];
}
