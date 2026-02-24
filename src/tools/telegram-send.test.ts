import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { telegramSend } from "./telegram-send.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-telegram-send-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("telegram_send rejects blank text with guidance", async () => {
  await withDb(async (db) => {
    let sendCalls = 0;
    const result = await telegramSend.execute(
      {
        text: "   ",
        chatId: 1000000001,
      },
      {
        db,
        stateDir: process.cwd(),
        workspaceDir: process.cwd(),
        codeDir: process.cwd(),
        telegram: {
          sendOutput: async () => {
            sendCalls += 1;
          },
          sendFile: async () => {},
          allowFrom: [],
          allowAll: true,
        },
        request: {
          channel: "internal_events",
          channelKey: "main",
          agentId: "main",
        },
        nowMs: () => Date.now(),
        log: () => {},
      } as any,
    );

    assert.match(result, /text is blank/i);
    assert.match(result, /provide a concise user-facing update/i);
    assert.equal(sendCalls, 0);
  });
});

test("telegram_send trims text before sending", async () => {
  await withDb(async (db) => {
    let sentText = "";
    const result = await telegramSend.execute(
      {
        text: "  Status: deploy complete.  ",
        chatId: 1000000001,
      },
      {
        db,
        stateDir: process.cwd(),
        workspaceDir: process.cwd(),
        codeDir: process.cwd(),
        telegram: {
          sendOutput: async (_chatId: number, output: string) => {
            sentText = output;
          },
          sendFile: async () => {},
          allowFrom: [],
          allowAll: true,
        },
        request: {
          channel: "internal_events",
          channelKey: "main",
          agentId: "main",
        },
        nowMs: () => Date.now(),
        log: () => {},
      } as any,
    );

    assert.equal(result, "OK");
    assert.equal(sentText, "Status: deploy complete.");
  });
});
