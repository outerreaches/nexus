import type { NexusDatabase } from "../storage/database.js";
import {
  fulfillHumanAction,
  getHumanAction,
  type HumanActionRow,
} from "../storage/human-actions.js";
import {
  formatDeployApprovalFulfillmentMessage,
  isDeployApprovalMetadata,
  parseMetadataJson,
  syncCandidateForDeployApproval,
} from "../core/deploy-approval.js";
import { syncDeployRequestForHumanAction } from "../core/deploy-requests.js";

/** A selectable response for a pending human action: channels render these as
 *  one-tap options (Telegram inline keyboard, CLI arrow picker) instead of
 *  making the user copy the action id into /act. */
export type QuickResponse = {
  label: string;
  response: string;
};

/** Confirm-kind actions get one-tap approve/deny. Input-kind actions need
 *  free text (OTP, CAPTCHA answer, …) so they return null and keep the
 *  existing /act <id> <text> flow. */
export function quickResponsesForHumanAction(
  row: Pick<HumanActionRow, "kind" | "status">,
): QuickResponse[] | null {
  if (row.status !== "pending") return null;
  if (row.kind !== "confirm") return null;
  return [
    { label: "✅ Approve", response: "approve" },
    { label: "❌ Deny", response: "deny" },
  ];
}

// Matches ids from randomActionId(): "HA" + 10 chars of the unambiguous
// alphabet ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (no I, O, 0, 1).
const HUMAN_ACTION_ID_PATTERN = /\bHA[A-HJ-NP-Z2-9]{10}\b/g;

export function findHumanActionIds(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(HUMAN_ACTION_ID_PATTERN)) {
    seen.add(match[0]);
  }
  return [...seen];
}

/** Pending confirm-kind actions referenced by id in an outgoing message —
 *  the channel attaches quick-response controls for these. */
export function listPendingConfirmActionsInText(
  db: NexusDatabase,
  text: string,
  nowMs: number,
): HumanActionRow[] {
  const rows: HumanActionRow[] = [];
  for (const id of findHumanActionIds(text)) {
    const row = getHumanAction(db, { id, nowMs });
    if (!row) continue;
    if (row.status !== "pending" || row.kind !== "confirm") continue;
    rows.push(row);
  }
  return rows;
}

export type FulfillHumanActionResult = {
  ok: boolean;
  error?: string;
  row?: HumanActionRow;
  /** Set when the action was a deploy approval: the channel should send this
   *  message and skip re-invoking the agent (the deploy continues via the
   *  backend worker, mirroring the /act flow). */
  deployFulfillmentMessage?: string;
};

/** Record a human action response and run the downstream syncs (deploy
 *  request + candidate state). Single fulfillment path shared by the Telegram
 *  /act command, Telegram inline-keyboard callbacks, and the CLI picker. */
export async function fulfillHumanActionWithSync(params: {
  db: NexusDatabase;
  id: string;
  responseText: string;
  respondedByChannel: string;
  respondedByKey: string;
  candidateRootDir?: string;
  nowMs: number;
  log?: (msg: string) => void;
}): Promise<FulfillHumanActionResult> {
  const result = fulfillHumanAction(params.db, {
    id: params.id,
    responseText: params.responseText,
    respondedByChannel: params.respondedByChannel,
    respondedByKey: params.respondedByKey,
    nowMs: params.nowMs,
  });
  if (!result.ok) {
    return { ok: false, error: result.error ?? "unknown" };
  }

  const row = getHumanAction(params.db, { id: params.id, nowMs: params.nowMs });
  if (row) {
    await syncCandidateForDeployApproval({
      candidateRootDir: params.candidateRootDir,
      approvalId: row.id,
      metadataJson: row.metadataJson,
      status: row.status,
      responseText: row.responseText,
      nowMs: params.nowMs,
      log: params.log,
    });
    syncDeployRequestForHumanAction({
      db: params.db,
      approvalId: row.id,
      metadataJson: row.metadataJson,
      status: row.status,
      responseText: row.responseText,
      nowMs: params.nowMs,
    });
  }

  const metadata = parseMetadataJson(row?.metadataJson ?? null);
  if (isDeployApprovalMetadata(metadata)) {
    return {
      ok: true,
      row: row ?? undefined,
      deployFulfillmentMessage: formatDeployApprovalFulfillmentMessage({
        approvalId: params.id,
        responseText: row?.responseText ?? params.responseText,
      }),
    };
  }
  return { ok: true, row: row ?? undefined };
}

/** Telegram callback_data payload for a quick response (64-byte API limit:
 *  "ha:" + 12-char id + ":" + short response stays well under). */
export function encodeQuickResponseCallback(id: string, response: string): string {
  return `ha:${id}:${response}`;
}

export function decodeQuickResponseCallback(
  data: string,
): { id: string; response: string } | null {
  const match = /^ha:(HA[A-HJ-NP-Z2-9]{10}):(approve|deny)$/.exec(data);
  if (!match) return null;
  return { id: match[1]!, response: match[2]! };
}
