import type { Tool } from "../core/tools.js";

import { fileEdit, fileList, fileRead, fileWrite } from "./file-ops.js";
import { browserTool } from "./browser.js";
import { marketData } from "./markets.js";
import { toolsReload } from "./registry.js";
import { shellExec } from "./system.js";
import { processList, processLogs, processStart, processStatus, processStop } from "./process.js";
import { webFetch } from "./web.js";
import { webSearch } from "./web-search.js";
import { paperTrade, portfolioStatus } from "./trading.js";
import { gatewayRestart } from "./lifecycle.js";
import { gmailGetMessage, gmailProfile, gmailSearch, gmailSend } from "./gmail.js";
import { credentialDelete, credentialGenerate, credentialList, credentialSet } from "./credentials.js";
import { humanRequest, humanStatus } from "./human-actions.js";
import { jobCreate, jobDelete, jobEvents, jobGet, jobList, jobPause, jobResume, jobRunGet, jobRunNow, jobRuns, jobUpdate } from "./jobs.js";
import { telegramSend } from "./telegram-send.js";

export function getBuiltInTools(): Tool[] {
  return [
    fileRead,
    fileWrite,
    fileEdit,
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
    marketData,
    toolsReload,
    gatewayRestart,
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
  ];
}
