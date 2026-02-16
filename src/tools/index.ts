import type { Tool } from "../core/tools.js";

import { fileEdit, fileEditLines, fileList, fileRead, fileWrite } from "./file-ops.js";
import { browserTool } from "./browser.js";
import { queryData } from "./query-data.js";
import { toolsReload } from "./registry.js";
import { shellExec } from "./system.js";
import { processList, processLogs, processStart, processStatus, processStop } from "./process.js";
import { nodeDelete, nodeGet, nodeList } from "./nodes.js";
import { webFetch } from "./web.js";
import { webSearch } from "./web-search.js";
import { imageAnalyze } from "./image-analyze.js";
import { imageGenerate } from "./image-generate.js";
import { imageEdit } from "./image-edit.js";
import { langextractExtract } from "./langextract.js";
import { paperTrade, portfolioStatus } from "./trading.js";
import { gatewayRestart } from "./lifecycle.js";
import { haDeploy } from "./ha-deploy.js";
import { gmailGetMessage, gmailProfile, gmailSearch, gmailSend } from "./gmail.js";
import { credentialDelete, credentialGenerate, credentialList, credentialSet } from "./credentials.js";
import { humanRequest, humanStatus } from "./human-actions.js";
import { jobCreate, jobDelete, jobEvents, jobGet, jobList, jobPause, jobResume, jobRunGet, jobRunNow, jobRuns, jobUpdate } from "./jobs.js";
import { telegramSend, telegramSendFile } from "./telegram-send.js";
import { memoryStore, memoryRecall, memorySearch, memoryDelete } from "./memory.js";
import { skillCreate, skillList, skillUpdate } from "./skills.js";
import { writeToBlackboard, readFromBlackboard, blackboardManage } from "./blackboard.js";
import { toolCatalog } from "./tool-catalog.js";
import { dbMaintenance } from "./db-maintenance.js";
import { dbBackup } from "./db-backup.js";
import { spawnAgent } from "./spawn-agent.js";
import {
  mcpDelegate,
  mcpOverview,
  mcpProfileCreate,
  mcpProfileDelete,
  mcpProfileList,
  mcpProfileUpdate,
  mcpServerActivate,
  mcpServerAdd,
  mcpServerDeactivate,
  mcpServerList,
  mcpServerProbe,
  mcpServerRemove,
  mcpServerUpdate,
} from "./mcp.js";
import {
  dataIntakeListSources,
  dataIntakePrune,
  dataIntakeQuery,
  dataIntakeRun,
  dataIntakeScheduleAll,
  dataIntakeScheduleRefresh,
} from "./data-intake.js";
import {
  dataIntakeSourceAdd,
  dataIntakeSourceDelete,
  dataIntakeSourceList,
  dataIntakeSourceUpdate,
} from "./data-intake-sources.js";

export function getBuiltInTools(): Tool[] {
  return [
    fileRead,
    fileWrite,
    fileEdit,
    fileEditLines,
    fileList,
    webFetch,
    webSearch,
    imageAnalyze,
    imageGenerate,
    imageEdit,
    langextractExtract,
    shellExec,
    processStart,
    processList,
    processStatus,
    processLogs,
    processStop,
    nodeList,
    nodeGet,
    nodeDelete,
    browserTool,
    queryData,
    toolsReload,
    gatewayRestart,
    haDeploy,
    paperTrade,
    portfolioStatus,
    gmailProfile,
    gmailSearch,
    gmailGetMessage,
    gmailSend,
    credentialSet,
    credentialGenerate,
    credentialList,
    credentialDelete,
    humanRequest,
    humanStatus,
    telegramSend,
    telegramSendFile,
    jobCreate,
    jobList,
    jobGet,
    jobUpdate,
    jobPause,
    jobResume,
    jobRunNow,
    jobRuns,
    jobRunGet,
    jobEvents,
    jobDelete,
    memoryStore,
    memoryRecall,
    memorySearch,
    memoryDelete,
    skillCreate,
    skillList,
    skillUpdate,
    writeToBlackboard,
    readFromBlackboard,
    blackboardManage,
    toolCatalog,
    dataIntakeListSources,
    dataIntakeRun,
    dataIntakeQuery,
    dataIntakePrune,
    dataIntakeScheduleRefresh,
    dataIntakeScheduleAll,
    dataIntakeSourceList,
    dataIntakeSourceAdd,
    dataIntakeSourceUpdate,
    dataIntakeSourceDelete,
    spawnAgent,
    dbMaintenance,
    dbBackup,
    mcpOverview,
    mcpServerList,
    mcpServerAdd,
    mcpServerUpdate,
    mcpServerProbe,
    mcpServerActivate,
    mcpServerDeactivate,
    mcpServerRemove,
    mcpProfileList,
    mcpProfileCreate,
    mcpProfileUpdate,
    mcpProfileDelete,
    mcpDelegate,
  ];
}
