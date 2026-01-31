import type { Tool } from "../core/tools.js";

import { fileEdit, fileList, fileRead, fileWrite } from "./file-ops.js";
import { browserTool } from "./browser.js";
import { marketData } from "./markets.js";
import { toolsReload } from "./registry.js";
import { shellExec } from "./system.js";
import { webFetch } from "./web.js";
import { webSearch } from "./web-search.js";
import { paperTrade, portfolioStatus } from "./trading.js";
import { gatewayRestart } from "./lifecycle.js";

export function getBuiltInTools(): Tool[] {
  return [
    fileRead,
    fileWrite,
    fileEdit,
    fileList,
    webFetch,
    webSearch,
    shellExec,
    browserTool,
    marketData,
    toolsReload,
    gatewayRestart,
    paperTrade,
    portfolioStatus,
  ];
}
