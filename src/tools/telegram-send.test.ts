import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { setHomeSession } from "../storage/sessions.js";
import { telegramSend } from "./telegram-send.js";

const HOME_CHAT_ID = 1000000001;

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-telegram-send-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    setHomeSession({
      db,
      agentId: "main",
      channel: "telegram",
      channelKey: String(HOME_CHAT_ID),
      nowMs: Date.now(),
    });
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
    let sentChatId = 0;
    const result = await telegramSend.execute(
      {
        text: "  Status: deploy complete.  ",
      },
      {
        db,
        stateDir: process.cwd(),
        workspaceDir: process.cwd(),
        codeDir: process.cwd(),
        telegram: {
          sendOutput: async (chatId: number, output: string) => {
            sentChatId = chatId;
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
    assert.equal(sentChatId, HOME_CHAT_ID);
  });
});

test("telegram_send fails with clear error when no destination is available", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-telegram-send-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    const result = await telegramSend.execute(
      {
        text: "hello",
      },
      {
        db,
        stateDir: process.cwd(),
        workspaceDir: process.cwd(),
        codeDir: process.cwd(),
        telegram: {
          sendOutput: async () => {},
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

    assert.match(result, /no Telegram destination available/i);
    assert.match(result, /\/sethome/);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
