import type { Tool } from "../core/tools.js";

import { fileEdit, fileEditLines, fileList, fileRead, fileWrite } from "./file-ops.js";
import { browserTool } from "./browser.js";
import { queryData } from "./query-data.js";
import { toolsReload } from "./registry.js";
import { shellExec } from "./system.js";
import { processList, processLogs, processStart, processStatus, processStop } from "./process.js";
import { webFetch } from "./web.js";
import { webSearch } from "./web-search.js";
import { paperTrade, portfolioStatus } from "./trading.js";
import { gatewayRestart } from "./lifecycle.js";
import { haDeployRequest, haDeployStatus } from "./ha-deploy.js";
import { gmailGetMessage, gmailProfile, gmailSearch, gmailSend } from "./gmail.js";
import { credentialDelete, credentialGenerate, credentialList, credentialSet } from "./credentials.js";
import { humanRequest, humanStatus } from "./human-actions.js";
import { jobCreate, jobDelete, jobEvents, jobGet, jobList, jobPause, jobResume, jobRunGet, jobRunNow, jobRuns, jobUpdate } from "./jobs.js";
import { telegramSend } from "./telegram-send.js";
import { memoryStore, memoryRecall, memorySearch, memoryDelete } from "./memory.js";
import { skillCreate, skillList, skillUpdate } from "./skills.js";
import { budgetStatus } from "./budget.js";
import { reflect } from "./reflect.js";
import { planTask } from "./plan.js";
import { writeToBlackboard, readFromBlackboard, blackboardClear, blackboardDelete, blackboardPrune } from "./blackboard.js";
import { dbMaintenance } from "./db-maintenance.js";
import { dbBackup } from "./db-backup.js";
import { spawnAgent } from "./spawn-agent.js";
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
    shellExec,
    processStart,
    processList,
    processStatus,
    processLogs,
    processStop,
    browserTool,
    queryData,
    toolsReload,
    gatewayRestart,
    haDeployRequest,
    haDeployStatus,
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
    budgetStatus,
    reflect,
    planTask,
    writeToBlackboard,
    readFromBlackboard,
    blackboardClear,
    blackboardDelete,
    blackboardPrune,
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
  ];
}
