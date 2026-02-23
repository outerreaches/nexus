import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { upsertWebhookEndpoint, upsertWebhookSubscription } from "../storage/federation.js";
import { createNodeWebhookIngressHandler } from "./webhook-ingress.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-node-webhook-ingress-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("node webhook handler stores inbound event and queues orchestrator report", async () => {
  await withDb(async (db) => {
    upsertWebhookEndpoint(db, {
      id: "wep-node-1",
      ownerScope: "local",
      url: "https://local.internal/webhook",
    });
    upsertWebhookSubscription(db, {
      id: "wsub-node-1",
      endpointId: "wep-node-1",
      eventType: "node.alert.*",
    });

    const handler = createNodeWebhookIngressHandler({
      db,
      log: () => {},
      targetAgentId: "main",
    });
    const handled = await handler.handle({
      nodeId: "node-a",
      sessionId: "sess-a",
      event: "webhook.deliver",
      receivedAt: Date.now(),
      payload: {
        eventId: "evt-node-1",
        traceId: "trace-node-1",
        kind: "node.alert.cpu",
        destination: {
          endpointId: "wep-node-1",
        },
        payload: {
          cpu: 95,
        },
      },
    });
    assert.equal(handled, true);

    const eventRow = db.db
      .prepare("SELECT event_type, envelope_id FROM federation_events WHERE envelope_id = ?")
      .get("evt-node-1") as { event_type: string; envelope_id: string } | undefined;
    assert.ok(eventRow);
    assert.equal(eventRow?.event_type, "node.alert.cpu");

    const reportRow = db.db
      .prepare("SELECT kind, target_agent_id, target_channel, title, metadata_json FROM run_reports WHERE kind = ?")
      .get("node_webhook") as
      | {
          kind: string;
          target_agent_id: string | null;
          target_channel: string;
          title: string;
          metadata_json: string;
        }
      | undefined;
    assert.ok(reportRow);
    assert.equal(reportRow?.target_agent_id, "main");
    assert.equal(reportRow?.target_channel, "agent");
    assert.match(reportRow?.title ?? "", /NODE WEBHOOK/);
    const metadata = JSON.parse(reportRow?.metadata_json ?? "{}") as Record<string, unknown>;
    assert.equal(metadata.targetPreset, "orchestrator");
    assert.equal(metadata.nodeId, "node-a");
  });
});

test("node webhook handler supports transport.event.ingest wrapper", async () => {
  await withDb(async (db) => {
    upsertWebhookEndpoint(db, {
      id: "wep-node-transport-1",
      ownerScope: "local",
      url: "https://local.internal/webhook",
    });

    const handler = createNodeWebhookIngressHandler({
      db,
      log: () => {},
    });
    const handled = await handler.handle({
      nodeId: "node-wrap-1",
      sessionId: "sess-wrap-1",
      event: "transport.event.ingest",
      receivedAt: Date.now(),
      payload: {
        eventType: "webhook.deliver",
        payload: {
          eventId: "evt-node-transport-1",
          traceId: "trace-node-transport-1",
          kind: "node.webhook.status",
          destination: {
            endpointId: "wep-node-transport-1",
          },
          payload: {
            ok: true,
          },
        },
      },
    });
    assert.equal(handled, true);
    const row = db.db
      .prepare("SELECT envelope_id FROM federation_events WHERE envelope_id = ?")
      .get("evt-node-transport-1") as { envelope_id: string } | undefined;
    assert.ok(row);
  });
});

test("node webhook handler redacts secret-like payload values in queued report", async () => {
  await withDb(async (db) => {
    upsertWebhookEndpoint(db, {
      id: "wep-node-secret-1",
      ownerScope: "local",
      url: "https://local.internal/webhook",
    });

    const handler = createNodeWebhookIngressHandler({
      db,
      log: () => {},
    });
    const handled = await handler.handle({
      nodeId: "node-secret-1",
      sessionId: "sess-secret-1",
      event: "webhook.deliver",
      receivedAt: Date.now(),
      payload: {
        eventId: "evt-node-secret-1",
        traceId: "trace-node-secret-1",
        kind: "node.webhook.secret",
        destination: {
          endpointId: "wep-node-secret-1",
        },
        payload: {
          apiKey: "sk-super-secret",
        },
      },
    });
    assert.equal(handled, true);

    const row = db.db
      .prepare("SELECT body FROM run_reports WHERE kind = ? ORDER BY created_at DESC LIMIT 1")
      .get("node_webhook") as { body: string } | undefined;
    assert.ok(row);
    const body = row?.body ?? "";
    assert.match(body, /redacted/i);
    assert.equal(body.includes("sk-super-secret"), false);
  });
});
