// Gateway module — HA notification helpers
import type { NexusConfig } from "../state/config.js";
import type { NexusDatabase } from "../storage/database.js";

export type HAEventType = "failover" | "failback" | "activate" | "deactivate" | "backup_failure";

export type HANotificationDeps = {
  config: NexusConfig;
  db: NexusDatabase;
  telegram?: {
    sendOutput: (chatId: number, text: string) => Promise<void>;
  } | null;
  log: (msg: string) => void;
};

async function listTelegramRecipients(db: NexusDatabase, config: NexusConfig): Promise<number[]> {
  const set = new Set<number>();

  // Add from config
  for (const id of config.channels.telegram.allowFrom ?? []) {
    if (Number.isFinite(id)) set.add(id);
  }

  // Add from database allowlist
  try {
    const rows = db.db.prepare("SELECT user_id FROM telegram_allowlist").all() as { user_id: number }[];
    for (const r of rows) {
      const id = Number(r.user_id);
      if (Number.isFinite(id)) set.add(id);
    }
  } catch {
    // Table may not exist yet
  }

  return [...set];
}

const EVENT_MESSAGES: Record<HAEventType, (details: Record<string, unknown>) => string> = {
  failover: (details) => `[NEXUS HA] FAILOVER TRIGGERED

Primary instance failed health checks. Standby has been activated.

From: ${details.from ?? "unknown"}
To: ${details.to ?? "unknown"}
Reason: ${details.reason ?? "health check failure"}`,

  failback: (details) => `[NEXUS HA] FAILBACK COMPLETE

Original primary recovered. Services restored to original primary.

From: ${details.from ?? "unknown"}
To: ${details.to ?? "unknown"}`,

  activate: (details) => `[NEXUS HA] Instance Activated

Instance has transitioned to ACTIVE mode.

Instance: ${details.instance ?? "unknown"}
Reason: ${details.reason ?? "manual activation"}`,

  deactivate: (details) => `[NEXUS HA] Instance Deactivated

Instance has transitioned to STANDBY mode.

Instance: ${details.instance ?? "unknown"}
Reason: ${details.reason ?? "manual deactivation"}`,

  backup_failure: (details) => `[NEXUS HA] BACKUP FAILED

Database backup failed. Manual intervention may be required.

Error: ${details.error ?? "unknown error"}
Backup ID: ${details.backupId ?? "unknown"}`,
};

export async function sendHANotification(
  deps: HANotificationDeps,
  event: {
    type: HAEventType;
    details: Record<string, unknown>;
  },
): Promise<void> {
  if (!deps.telegram || !deps.config.channels.telegram.enabled) {
    deps.log(`ha-notify: telegram not enabled, skipping ${event.type} notification`);
    return;
  }

  const recipients = await listTelegramRecipients(deps.db, deps.config);
  if (recipients.length === 0) {
    deps.log("ha-notify: no telegram recipients");
    return;
  }

  const messageFormatter = EVENT_MESSAGES[event.type];
  const text = messageFormatter ? messageFormatter(event.details) : `[NEXUS HA] ${event.type}\n\n${JSON.stringify(event.details, null, 2)}`;

  for (const chatId of recipients) {
    try {
      await deps.telegram.sendOutput(chatId, text);
      deps.log(`ha-notify: sent ${event.type} to chat_id=${chatId}`);
    } catch (e) {
      deps.log(`ha-notify: failed to send to chat_id=${chatId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
