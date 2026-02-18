import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Hono } from "hono";
import { parseNodePublicKey, signProtocolEnvelope } from "../nodes/auth.js";
import { buildWebhookCanonicalSigningInput, signWebhookCanonicalInput } from "../federation/webhook.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { upsertCredential } from "../secrets/credentials.js";
import type { GatewayHttpDeps } from "./http.js";
import { registerApiRoutes } from "./routes/api.js";

async function withDb(fn: (db: NexusDatabase, app: Hono, stateDir: string) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-federation-api-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  const app = new Hono();
  let globalDisable = false;
  const deps: GatewayHttpDeps = {
    port: 0,
    stateDir: dir,
    federationLocalInstanceId: "local",
    getFederationBreakglassState: () => ({ globalDisable }),
    setFederationGlobalDisable: (disabled: boolean) => {
      globalDisable = disabled;
      return { globalDisable };
    },
    db,
    getStatus: () => ({
      ok: true,
      runtime: { profile: "primary" },
      federation: {
        enabled: true,
        derivedState: "federated_degraded",
        trustedPeerCount: 0,
        healthyTrustedPeerCount: 0,
      },
    }),
    log: () => {},
  };
  registerApiRoutes(app, deps);
  try {
    await fn(db, app, dir);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("federation status route returns status payload", async () => {
  await withDb(async (_db, app) => {
    const res = await app.request("http://localhost/api/federation/status");
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.enabled, true);
    assert.equal(body.derivedState, "federated_degraded");
    assert.ok(typeof body.timestamp === "number");
  });
});

test("breakglass controls toggle global disable and support pause/revoke actions", async () => {
  await withDb(async (_db, app, stateDir) => {
    const breakglassInitial = await app.request("http://localhost/api/federation/breakglass");
    assert.equal(breakglassInitial.status, 200);
    const breakglassInitialBody = await breakglassInitial.json() as { state: { globalDisable: boolean } };
    assert.equal(breakglassInitialBody.state.globalDisable, false);

    const pair = generateKeyPairSync("ed25519");
    const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
    assert.ok(parsed);
    const peerRes = await app.request("http://localhost/api/federation/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-breakglass-1",
        label: "Peer Breakglass",
        endpoint: "https://peer-breakglass-1.internal",
        signingKey: parsed.raw,
        signingKeyKid: "kid-breakglass-1",
        trustState: "trusted",
      }),
    });
    assert.equal(peerRes.status, 200);

    const pauseRes = await app.request("http://localhost/api/federation/breakglass/pause_service", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        peerId: "peer-breakglass-1",
        paused: true,
      }),
    });
    assert.equal(pauseRes.status, 200);

    const globalDisableRes = await app.request("http://localhost/api/federation/breakglass/global", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        disabled: true,
      }),
    });
    assert.equal(globalDisableRes.status, 200);

    const submitRes = await app.request("http://localhost/api/federation/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        peerId: "peer-breakglass-1",
        method: "submit_task",
      }),
    });
    assert.equal(submitRes.status, 503);

    await upsertCredential({
      stateDir,
      id: "cred-revoke-1",
      note: "revoke-me",
    });
    const revokeRes = await app.request("http://localhost/api/federation/breakglass/revoke_credential", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "cred-revoke-1",
      }),
    });
    assert.equal(revokeRes.status, 200);
  });
});

test("federation peers/tasks/outbox routes support basic flow", async () => {
  await withDb(async (_db, app) => {
    const pair = generateKeyPairSync("ed25519");
    const publicPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const parsed = parseNodePublicKey(publicPem);
    assert.ok(parsed);

    const createPeerRes = await app.request("http://localhost/api/federation/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-1",
        label: "Monetization Peer",
        endpoint: "https://peer-1.internal",
        signingKey: parsed.raw,
        signingKeyKid: "kid-peer-1",
        trustState: "pending",
      }),
    });
    assert.equal(createPeerRes.status, 200);
    const createPeerBody = await createPeerRes.json() as { ok: boolean; peer: { id: string } };
    assert.equal(createPeerBody.ok, true);
    assert.equal(createPeerBody.peer.id, "peer-1");

    const trustRes = await app.request("http://localhost/api/federation/peers/peer-1/trust", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trustState: "trusted" }),
    });
    assert.equal(trustRes.status, 200);
    const trustBody = await trustRes.json() as { peer: { trustState: string } };
    assert.equal(trustBody.peer.trustState, "trusted");

    const createTaskRes = await app.request("http://localhost/api/federation/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        peerId: "peer-1",
        method: "submit_task",
        request: { kind: "paper_trade", symbol: "BTC-USD" },
      }),
    });
    assert.equal(createTaskRes.status, 200);
    const createTaskBody = await createTaskRes.json() as { task: { id: string; status: string } };
    assert.equal(createTaskBody.task.status, "pending");
    const taskId = createTaskBody.task.id;

    const outboxRes = await app.request("http://localhost/api/federation/outbox?status=pending");
    assert.equal(outboxRes.status, 200);
    const outboxBody = await outboxRes.json() as { outbox: Array<{ traceId: string | null }> };
    assert.equal(outboxBody.outbox.length, 1);
    assert.equal(outboxBody.outbox[0]?.traceId, taskId);

    const updateTaskRes = await app.request(`http://localhost/api/federation/tasks/${taskId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        result: { ok: true },
      }),
    });
    assert.equal(updateTaskRes.status, 200);
    const updateTaskBody = await updateTaskRes.json() as { task: { status: string } };
    assert.equal(updateTaskBody.task.status, "completed");

    const getTaskRes = await app.request(`http://localhost/api/federation/tasks/${taskId}`);
    assert.equal(getTaskRes.status, 200);
    const getTaskBody = await getTaskRes.json() as { task: { status: string } };
    assert.equal(getTaskBody.task.status, "completed");
  });
});

test("federation inbox verifies signed envelope and applies task submit idempotently", async () => {
  await withDb(async (_db, app) => {
    const pair = generateKeyPairSync("ed25519");
    const publicPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const parsed = parseNodePublicKey(publicPem);
    assert.ok(parsed);

    const peerRes = await app.request("http://localhost/api/federation/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-inbox-1",
        label: "Peer Inbox",
        endpoint: "https://peer-inbox-1.internal",
        signingKey: parsed.raw,
        signingKeyKid: "kid-test",
        trustState: "trusted",
      }),
    });
    assert.equal(peerRes.status, 200);

    const ts = Date.now();
    const unsigned = {
      envelopeId: "env-1",
      schemaVersion: "federation.v1",
      transportKind: "federation_http",
      source: "peer-inbox-1",
      destination: "local",
      methodOrEvent: "submit_task",
      ts,
      nonce: "nonce-1",
      payload: {
        taskId: "task-inbox-1",
        method: "submit_task",
        request: { symbol: "ETH-USD" },
      },
      idempotencyKey: "task-inbox-1",
      traceId: "trace-inbox-1",
      kid: "kid-test",
    };
    const sig = signProtocolEnvelope(unsigned as Record<string, unknown>, pair.privateKey);
    const signed = { ...unsigned, sig };

    const inboxRes = await app.request("http://localhost/api/federation/inbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nexus-instance-id": "peer-inbox-1",
        "x-nexus-kid": "kid-test",
        "x-nexus-public-key": parsed.raw,
      },
      body: JSON.stringify(signed),
    });
    assert.equal(inboxRes.status, 202);
    const inboxBody = await inboxRes.json() as { ok: boolean; taskId: string };
    assert.equal(inboxBody.ok, true);
    assert.equal(inboxBody.taskId, "task-inbox-1");

    const taskRes = await app.request("http://localhost/api/federation/tasks/task-inbox-1");
    assert.equal(taskRes.status, 200);
    const taskBody = await taskRes.json() as { task: { status: string; peerId: string } };
    assert.equal(taskBody.task.status, "pending");
    assert.equal(taskBody.task.peerId, "peer-inbox-1");

    const unknownKidUnsigned = {
      ...unsigned,
      envelopeId: "env-unknown-kid",
      traceId: "trace-unknown-kid",
      kid: "kid-unknown",
      nonce: "nonce-unknown-kid",
    };
    const unknownKidSig = signProtocolEnvelope(unknownKidUnsigned as Record<string, unknown>, pair.privateKey);
    const unknownKidRes = await app.request("http://localhost/api/federation/inbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nexus-instance-id": "peer-inbox-1",
      },
      body: JSON.stringify({ ...unknownKidUnsigned, sig: unknownKidSig }),
    });
    assert.equal(unknownKidRes.status, 401);

    const replayUnsigned = {
      ...unsigned,
      envelopeId: "env-2",
      traceId: "trace-inbox-2",
      payload: {
        taskId: "task-inbox-2",
        method: "submit_task",
        request: { symbol: "BTC-USD" },
      },
    };
    const replaySig = signProtocolEnvelope(replayUnsigned as Record<string, unknown>, pair.privateKey);
    const replayRes = await app.request("http://localhost/api/federation/inbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nexus-instance-id": "peer-inbox-1",
      },
      body: JSON.stringify({ ...replayUnsigned, sig: replaySig }),
    });
    assert.equal(replayRes.status, 401);

    const duplicateRes = await app.request("http://localhost/api/federation/inbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nexus-instance-id": "peer-inbox-1",
      },
      body: JSON.stringify(signed),
    });
    assert.equal(duplicateRes.status, 409);
    const duplicateBody = await duplicateRes.json() as { ok: boolean; duplicate: boolean };
    assert.equal(duplicateBody.ok, true);
    assert.equal(duplicateBody.duplicate, true);
  });
});

test("legacy key migration only persists kid after signature verification", async () => {
  await withDb(async (db, app) => {
    const peerPair = generateKeyPairSync("ed25519");
    const peerParsed = parseNodePublicKey(peerPair.publicKey.export({ format: "pem", type: "spki" }).toString());
    assert.ok(peerParsed);
    const attackerPair = generateKeyPairSync("ed25519");

    const createPeerRes = await app.request("http://localhost/api/federation/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-legacy-1",
        label: "Legacy Peer",
        endpoint: "https://peer-legacy-1.internal",
        signingKey: peerParsed.raw,
        signingKeyKid: "kid-initial",
        trustState: "trusted",
      }),
    });
    assert.equal(createPeerRes.status, 200);

    db.db.prepare("DELETE FROM identity_keyring WHERE scope = ?").run("federation_peer:peer-legacy-1");

    const ts = Date.now();
    const forgedUnsigned = {
      envelopeId: "env-forged",
      schemaVersion: "federation.v1",
      transportKind: "federation_http",
      source: "peer-legacy-1",
      destination: "local",
      methodOrEvent: "submit_task",
      ts,
      nonce: "nonce-forged",
      payload: { taskId: "task-forged", method: "submit_task", request: { symbol: "DOGE-USD" } },
      idempotencyKey: "task-forged",
      traceId: "trace-forged",
      kid: "kid-evil",
    };
    const forgedSig = signProtocolEnvelope(forgedUnsigned as Record<string, unknown>, attackerPair.privateKey);
    const forgedRes = await app.request("http://localhost/api/federation/inbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nexus-instance-id": "peer-legacy-1",
      },
      body: JSON.stringify({ ...forgedUnsigned, sig: forgedSig }),
    });
    assert.equal(forgedRes.status, 401);

    const afterForgedCount = db.db
      .prepare("SELECT COUNT(*) as cnt FROM identity_keyring WHERE scope = ?")
      .get("federation_peer:peer-legacy-1") as { cnt: number };
    assert.equal(afterForgedCount.cnt, 0);

    const legitUnsigned = {
      ...forgedUnsigned,
      envelopeId: "env-legit",
      nonce: "nonce-legit",
      payload: { taskId: "task-legit", method: "submit_task", request: { symbol: "SOL-USD" } },
      idempotencyKey: "task-legit",
      traceId: "trace-legit",
      kid: "kid-good",
    };
    const legitSig = signProtocolEnvelope(legitUnsigned as Record<string, unknown>, peerPair.privateKey);
    const legitRes = await app.request("http://localhost/api/federation/inbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nexus-instance-id": "peer-legacy-1",
        "x-nexus-kid": "kid-good",
      },
      body: JSON.stringify({ ...legitUnsigned, sig: legitSig }),
    });
    assert.equal(legitRes.status, 202);

    const kids = db.db
      .prepare("SELECT kid FROM identity_keyring WHERE scope = ? ORDER BY kid ASC")
      .all("federation_peer:peer-legacy-1") as Array<{ kid: string }>;
    assert.deepEqual(kids.map((row) => row.kid), ["kid-good"]);
  });
});

test("federation task creation denies blocked egress method and records firewall audit", async () => {
  await withDb(async (db, app) => {
    const pair = generateKeyPairSync("ed25519");
    const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
    assert.ok(parsed);

    const peerRes = await app.request("http://localhost/api/federation/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-egress-blocked",
        label: "Peer Egress Blocked",
        endpoint: "https://peer-egress-blocked.internal",
        signingKey: parsed.raw,
        signingKeyKid: "kid-egress",
        trustState: "trusted",
      }),
    });
    assert.equal(peerRes.status, 200);

    const taskRes = await app.request("http://localhost/api/federation/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        peerId: "peer-egress-blocked",
        method: "shell_exec",
        request: { command: "echo nope" },
      }),
    });
    assert.equal(taskRes.status, 403);

    const audit = db.db
      .prepare(
        "SELECT event_type, decision, details_json FROM federation_audit WHERE peer_id = ? AND event_type = 'firewall.egress' ORDER BY created_at DESC LIMIT 1",
      )
      .get("peer-egress-blocked") as { event_type: string; decision: string | null; details_json: string } | undefined;
    assert.ok(audit);
    assert.equal(audit?.event_type, "firewall.egress");
    assert.equal(audit?.decision, "deny");
    const details = JSON.parse(audit?.details_json ?? "{}") as { reason?: string };
    assert.ok(String(details.reason ?? "").startsWith("blocked_method:"));
  });
});

test("federation inbox denies blocked ingress method and records firewall audit", async () => {
  await withDb(async (db, app) => {
    const pair = generateKeyPairSync("ed25519");
    const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
    assert.ok(parsed);

    const peerRes = await app.request("http://localhost/api/federation/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-ingress-blocked",
        label: "Peer Ingress Blocked",
        endpoint: "https://peer-ingress-blocked.internal",
        signingKey: parsed.raw,
        signingKeyKid: "kid-ingress",
        trustState: "trusted",
      }),
    });
    assert.equal(peerRes.status, 200);

    const ts = Date.now();
    const unsigned = {
      envelopeId: "env-ingress-blocked",
      schemaVersion: "federation.v1",
      transportKind: "federation_http",
      source: "peer-ingress-blocked",
      destination: "local",
      methodOrEvent: "shell_exec",
      ts,
      nonce: "nonce-ingress-blocked",
      payload: { command: "echo blocked" },
      idempotencyKey: "idmp-ingress-blocked",
      traceId: "trace-ingress-blocked",
      kid: "kid-ingress",
    };
    const sig = signProtocolEnvelope(unsigned as Record<string, unknown>, pair.privateKey);
    const res = await app.request("http://localhost/api/federation/inbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nexus-instance-id": "peer-ingress-blocked",
        "x-nexus-kid": "kid-ingress",
      },
      body: JSON.stringify({ ...unsigned, sig }),
    });
    assert.equal(res.status, 403);

    const audit = db.db
      .prepare(
        "SELECT event_type, decision, details_json FROM federation_audit WHERE peer_id = ? AND event_type = 'firewall.ingress' ORDER BY created_at DESC LIMIT 1",
      )
      .get("peer-ingress-blocked") as { event_type: string; decision: string | null; details_json: string } | undefined;
    assert.ok(audit);
    assert.equal(audit?.event_type, "firewall.ingress");
    assert.equal(audit?.decision, "deny");
    const details = JSON.parse(audit?.details_json ?? "{}") as { reason?: string };
    assert.ok(String(details.reason ?? "").startsWith("blocked_method:"));
  });
});

test("federation inbox denies destination mismatch and records firewall audit", async () => {
  await withDb(async (db, app) => {
    const pair = generateKeyPairSync("ed25519");
    const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
    assert.ok(parsed);

    const peerRes = await app.request("http://localhost/api/federation/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-destination-mismatch",
        label: "Peer Destination Mismatch",
        endpoint: "https://peer-destination-mismatch.internal",
        signingKey: parsed.raw,
        signingKeyKid: "kid-destination",
        trustState: "trusted",
      }),
    });
    assert.equal(peerRes.status, 200);

    const ts = Date.now();
    const unsigned = {
      envelopeId: "env-destination-mismatch",
      schemaVersion: "federation.v1",
      transportKind: "federation_http",
      source: "peer-destination-mismatch",
      destination: "not-local",
      methodOrEvent: "submit_task",
      ts,
      nonce: "nonce-destination-mismatch",
      payload: {
        taskId: "task-destination-mismatch",
        method: "submit_task",
        request: { symbol: "ADA-USD" },
      },
      idempotencyKey: "task-destination-mismatch",
      traceId: "trace-destination-mismatch",
      kid: "kid-destination",
    };
    const sig = signProtocolEnvelope(unsigned as Record<string, unknown>, pair.privateKey);
    const res = await app.request("http://localhost/api/federation/inbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nexus-instance-id": "peer-destination-mismatch",
      },
      body: JSON.stringify({ ...unsigned, sig }),
    });
    assert.equal(res.status, 403);

    const audit = db.db
      .prepare(
        "SELECT event_type, decision, details_json FROM federation_audit WHERE event_type = 'firewall.ingress' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { event_type: string; decision: string | null; details_json: string } | undefined;
    assert.ok(audit);
    assert.equal(audit?.event_type, "firewall.ingress");
    assert.equal(audit?.decision, "deny");
    const details = JSON.parse(audit?.details_json ?? "{}") as { reason?: string; expectedDestination?: string };
    assert.equal(details.reason, "destination_mismatch");
    assert.equal(details.expectedDestination, "local");
  });
});

test("federation exports and grants CRUD endpoints work", async () => {
  await withDb(async (_db, app) => {
    const pair = generateKeyPairSync("ed25519");
    const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
    assert.ok(parsed);

    const peerRes = await app.request("http://localhost/api/federation/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-grants-1",
        label: "Peer Grants",
        endpoint: "https://peer-grants-1.internal",
        signingKey: parsed.raw,
        signingKeyKid: "kid-grants",
        trustState: "trusted",
      }),
    });
    assert.equal(peerRes.status, 200);

    const exportRes = await app.request("http://localhost/api/federation/exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "exp-1",
        resourceType: "node_pool",
        resourceSelector: { pool: "shared" },
        projection: { fields: ["id", "status"] },
      }),
    });
    assert.equal(exportRes.status, 200);
    const exportBody = await exportRes.json() as { ok: boolean; export: { id: string } };
    assert.equal(exportBody.ok, true);
    assert.equal(exportBody.export.id, "exp-1");

    const grantRes = await app.request("http://localhost/api/federation/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "gr-1",
        peerId: "peer-grants-1",
        exportId: "exp-1",
        permission: "read",
        sensitivityCeiling: "internal",
      }),
    });
    assert.equal(grantRes.status, 200);
    const grantBody = await grantRes.json() as { ok: boolean; grant: { id: string } };
    assert.equal(grantBody.ok, true);
    assert.equal(grantBody.grant.id, "gr-1");

    const listRes = await app.request("http://localhost/api/federation/grants?peerId=peer-grants-1");
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json() as { grants: Array<{ exportId: string }> };
    assert.equal(listBody.grants.length, 1);
    assert.equal(listBody.grants[0]?.exportId, "exp-1");
  });
});

test("webhook endpoint/subscription/delivery routes enqueue and replay deliveries", async () => {
  await withDb(async (db, app) => {
    const pair = generateKeyPairSync("ed25519");
    const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
    assert.ok(parsed);
    const peerRes = await app.request("http://localhost/api/federation/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-webhook-delivery-1",
        label: "Peer Webhook Delivery",
        endpoint: "https://peer-webhook-delivery-1.internal",
        signingKey: parsed.raw,
        signingKeyKid: "kid-webhook-delivery-1",
        trustState: "trusted",
      }),
    });
    assert.equal(peerRes.status, 200);

    const endpointRes = await app.request("http://localhost/api/webhooks/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "wep-1",
        ownerScope: "federation_peer",
        peerId: "peer-webhook-delivery-1",
        url: "https://peer-webhook-delivery-1.internal/federation-webhook",
        signingMode: "ed25519",
        eventFilter: ["federation.task.*"],
      }),
    });
    assert.equal(endpointRes.status, 200);

    const subRes = await app.request("http://localhost/api/webhooks/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "wsub-1",
        endpointId: "wep-1",
        eventType: "federation.task.*",
      }),
    });
    assert.equal(subRes.status, 200);

    db.db
      .prepare(
        `INSERT INTO federation_events (
           id,
           peer_id,
           event_type,
           direction,
           envelope_id,
           payload_json,
           trace_id,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "evt-1",
        null,
        "federation.task.updated",
        "outbound",
        "env-evt-1",
        JSON.stringify({ ok: true }),
        "trace-evt-1",
        Date.now(),
      );

    const queueRes = await app.request("http://localhost/api/webhooks/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "wdel-1",
        endpointId: "wep-1",
        eventId: "evt-1",
      }),
    });
    assert.equal(queueRes.status, 202);

    const deliveriesRes = await app.request("http://localhost/api/webhooks/deliveries");
    assert.equal(deliveriesRes.status, 200);
    const deliveriesBody = await deliveriesRes.json() as { deliveries: Array<{ id: string; status: string }> };
    assert.equal(deliveriesBody.deliveries.length, 1);
    assert.equal(deliveriesBody.deliveries[0]?.id, "wdel-1");
    assert.equal(deliveriesBody.deliveries[0]?.status, "pending");

    const replayRes = await app.request("http://localhost/api/webhooks/deliveries/wdel-1/replay", {
      method: "POST",
    });
    assert.equal(replayRes.status, 200);
  });
});

test("webhook endpoint creation blocks local endpoints in federated_only mode", async () => {
  await withDb(async (_db, app) => {
    const endpointRes = await app.request("http://localhost/api/webhooks/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "wep-local-blocked",
        ownerScope: "local",
        url: "https://example.com/hook",
      }),
    });
    assert.equal(endpointRes.status, 403);
  });
});

test("webhook endpoint creation rejects insecure http urls by default", async () => {
  await withDb(async (db, app) => {
    const pair = generateKeyPairSync("ed25519");
    const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
    assert.ok(parsed);

    const peerRes = await app.request("http://localhost/api/federation/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-http-1",
        label: "Peer HTTP",
        endpoint: "https://peer-http-1.internal",
        signingKey: parsed.raw,
        signingKeyKid: "kid-peer-http-1",
        trustState: "trusted",
      }),
    });
    assert.equal(peerRes.status, 200);

    const endpointRes = await app.request("http://localhost/api/webhooks/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "wep-http-1",
        ownerScope: "federation_peer",
        peerId: "peer-http-1",
        url: "http://peer-http-1.internal/federation-webhook",
      }),
    });
    assert.equal(endpointRes.status, 400);

    const row = db.db.prepare("SELECT id FROM webhook_endpoints WHERE id = ?").get("wep-http-1") as { id: string } | undefined;
    assert.equal(row, undefined);
  });
});

test("webhook endpoint creation enforces signing mode and secretRef constraints", async () => {
  await withDb(async (_db, app) => {
    const pair = generateKeyPairSync("ed25519");
    const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
    assert.ok(parsed);
    const peerRes = await app.request("http://localhost/api/federation/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-hmac-validate",
        label: "Peer HMAC Validate",
        endpoint: "https://peer-hmac-validate.internal",
        signingKey: parsed.raw,
        signingKeyKid: "kid-peer-hmac",
        trustState: "trusted",
      }),
    });
    assert.equal(peerRes.status, 200);

    const missingSecretRes = await app.request("http://localhost/api/webhooks/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "wep-hmac-missing",
        ownerScope: "federation_peer",
        peerId: "peer-hmac-validate",
        url: "https://peer-hmac-validate.internal/federation-webhook",
        signingMode: "hmac",
      }),
    });
    assert.equal(missingSecretRes.status, 400);

    const invalidSecretRes = await app.request("http://localhost/api/webhooks/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "wep-hmac-invalid",
        ownerScope: "federation_peer",
        peerId: "peer-hmac-validate",
        url: "https://peer-hmac-validate.internal/federation-webhook",
        signingMode: "ed25519",
        secretRef: "plain-text-not-ref",
      }),
    });
    assert.equal(invalidSecretRes.status, 400);
  });
});

test("monetization profile locks control-plane mutation endpoints", async () => {
  await withDb(async (db) => {
    const app = new Hono();
    const deps: GatewayHttpDeps = {
      port: 0,
      stateDir: "",
      federationLocalInstanceId: "local",
      runtimeProfile: "monetization",
      db,
      getStatus: () => ({ ok: true }),
      log: () => {},
    };
    registerApiRoutes(app, deps);

    const peerMutation = await app.request("http://localhost/api/federation/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-monetization-locked",
        label: "peer",
        endpoint: "https://peer.local",
        signingKey: "invalid",
      }),
    });
    assert.equal(peerMutation.status, 403);

    const webhookMutation = await app.request("http://localhost/api/webhooks/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "wep-monetization-locked",
        ownerScope: "local",
        url: "https://example.com/hook",
      }),
    });
    assert.equal(webhookMutation.status, 403);
  });
});

test("federation webhook route verifies signature and enforces idempotency", async () => {
  await withDb(async (_db, app) => {
    const pair = generateKeyPairSync("ed25519");
    const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
    assert.ok(parsed);

    const peerRes = await app.request("http://localhost/api/federation/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-webhook-1",
        label: "Peer Webhook",
        endpoint: "https://peer-webhook-1.internal",
        signingKey: parsed.raw,
        signingKeyKid: "kid-webhook-1",
        trustState: "trusted",
      }),
    });
    assert.equal(peerRes.status, 200);

    const endpointRes = await app.request("http://localhost/api/webhooks/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "wep-fed-1",
        ownerScope: "federation_peer",
        peerId: "peer-webhook-1",
        url: "https://peer-webhook-1.internal/federation-webhook",
        eventFilter: ["federation.task.*"],
      }),
    });
    assert.equal(endpointRes.status, 200);

    const subRes = await app.request("http://localhost/api/webhooks/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "wsub-fed-1",
        endpointId: "wep-fed-1",
        eventType: "federation.task.*",
      }),
    });
    assert.equal(subRes.status, 200);

    const nowMs = Date.now();
    const payload = {
      schemaVersion: "1.0",
      eventId: "evt-fed-1",
      traceId: "trace-fed-1",
      kind: "federation.task.updated",
      sourceInstance: "peer-webhook-1",
      destination: {
        peerId: "peer-webhook-1",
        endpointId: "wep-fed-1",
      },
      ts: nowMs,
      nonce: "nonce-fed-1",
      idempotencyKey: "idmp-fed-1",
      sensitivity: "internal",
      payload: { taskId: "task-1", status: "running" },
      meta: {
        attempt: 1,
        maxAttempts: 12,
        orderingKey: "task:task-1",
      },
    };
    const bodyText = JSON.stringify(payload);
    const canonical = buildWebhookCanonicalSigningInput({
      method: "POST",
      path: "/federation-webhook",
      timestamp: String(nowMs),
      nonce: payload.nonce,
      eventId: payload.eventId,
      bodyBytes: bodyText,
    });
    const signature = signWebhookCanonicalInput(canonical, pair.privateKey);

    const unknownKid = await app.request("http://localhost/federation-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nexus-event-id": payload.eventId,
        "x-nexus-timestamp": String(nowMs),
        "x-nexus-nonce": payload.nonce,
        "x-nexus-signature": signature,
        "x-nexus-key-id": "kid-unknown",
        "x-nexus-attempt": "1",
        "x-nexus-instance-id": "peer-webhook-1",
      },
      body: bodyText,
    });
    assert.equal(unknownKid.status, 401);

    const first = await app.request("http://localhost/federation-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nexus-event-id": payload.eventId,
        "x-nexus-timestamp": String(nowMs),
        "x-nexus-nonce": payload.nonce,
        "x-nexus-signature": signature,
        "x-nexus-key-id": "kid-webhook-1",
        "x-nexus-attempt": "1",
        "x-nexus-instance-id": "peer-webhook-1",
      },
      body: bodyText,
    });
    assert.equal(first.status, 202);

    const duplicate = await app.request("http://localhost/federation-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nexus-event-id": payload.eventId,
        "x-nexus-timestamp": String(nowMs),
        "x-nexus-nonce": payload.nonce,
        "x-nexus-signature": signature,
        "x-nexus-key-id": "kid-webhook-1",
        "x-nexus-attempt": "1",
        "x-nexus-instance-id": "peer-webhook-1",
      },
      body: bodyText,
    });
    assert.equal(duplicate.status, 409);
  });
});

test("federation inbox rejects oversized request bodies", async () => {
  await withDb(async (_db, app) => {
    const oversizedPayload = JSON.stringify({
      envelopeId: "env-oversized",
      payload: "x".repeat(300_000),
    });
    const res = await app.request("http://localhost/api/federation/inbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: oversizedPayload,
    });
    assert.equal(res.status, 413);
  });
});

test("federation webhook rejects oversized request bodies", async () => {
  await withDb(async (_db, app) => {
    const oversizedPayload = JSON.stringify({
      eventId: "evt-oversized",
      payload: "x".repeat(300_000),
    });
    const res = await app.request("http://localhost/federation-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: oversizedPayload,
    });
    assert.equal(res.status, 413);
  });
});

test("federation webhook ingress applies shared-event projection policy", async () => {
  await withDb(async (db, app) => {
    const pair = generateKeyPairSync("ed25519");
    const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
    assert.ok(parsed);

    const peerRes = await app.request("http://localhost/api/federation/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-share-ingress-1",
        label: "Peer Share",
        endpoint: "https://peer-share-ingress-1.internal",
        signingKey: parsed.raw,
        signingKeyKid: "kid-share-ingress-1",
        trustState: "trusted",
      }),
    });
    assert.equal(peerRes.status, 200);

    const exportRes = await app.request("http://localhost/api/federation/exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "fexp-share-ingress-1",
        resourceType: "node_pool",
        projection: {
          includeFields: ["nodeId", "status", "apiKey", "localPath"],
          excludeFields: ["apiKey"],
        },
      }),
    });
    assert.equal(exportRes.status, 200);

    const grantRes = await app.request("http://localhost/api/federation/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "fgrant-share-ingress-1",
        peerId: "peer-share-ingress-1",
        exportId: "fexp-share-ingress-1",
        sensitivityCeiling: "internal",
      }),
    });
    assert.equal(grantRes.status, 200);

    const endpointRes = await app.request("http://localhost/api/webhooks/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "wep-share-ingress-1",
        ownerScope: "federation_peer",
        peerId: "peer-share-ingress-1",
        url: "https://peer-share-ingress-1.internal/federation-webhook",
      }),
    });
    assert.equal(endpointRes.status, 200);

    const subRes = await app.request("http://localhost/api/webhooks/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "wsub-share-ingress-1",
        endpointId: "wep-share-ingress-1",
        eventType: "node.share.*",
      }),
    });
    assert.equal(subRes.status, 200);

    const nowMs = Date.now();
    const payload = {
      schemaVersion: "1.0",
      eventId: "evt-share-ingress-1",
      traceId: "trace-share-ingress-1",
      kind: "node.share.updated",
      sourceInstance: "peer-share-ingress-1",
      destination: {
        peerId: "peer-share-ingress-1",
        endpointId: "wep-share-ingress-1",
      },
      ts: nowMs,
      nonce: "nonce-share-ingress-1",
      idempotencyKey: "idmp-share-ingress-1",
      sensitivity: "internal",
      payload: {
        nodeId: "node-1",
        status: "online",
        apiKey: "secret",
        localPath: "/tmp/private",
      },
      meta: {
        attempt: 1,
        maxAttempts: 12,
        orderingKey: "node:node-1",
      },
    };
    const bodyText = JSON.stringify(payload);
    const canonical = buildWebhookCanonicalSigningInput({
      method: "POST",
      path: "/federation-webhook",
      timestamp: String(nowMs),
      nonce: payload.nonce,
      eventId: payload.eventId,
      bodyBytes: bodyText,
    });
    const signature = signWebhookCanonicalInput(canonical, pair.privateKey);

    const res = await app.request("http://localhost/federation-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nexus-event-id": payload.eventId,
        "x-nexus-timestamp": String(nowMs),
        "x-nexus-nonce": payload.nonce,
        "x-nexus-signature": signature,
        "x-nexus-key-id": "kid-share-ingress-1",
        "x-nexus-attempt": "1",
        "x-nexus-instance-id": "peer-share-ingress-1",
      },
      body: bodyText,
    });
    assert.equal(res.status, 202);

    const stored = db.db
      .prepare("SELECT payload_json FROM federation_events WHERE envelope_id = ?")
      .get("evt-share-ingress-1") as { payload_json: string } | undefined;
    assert.ok(stored);
    const parsedStored = JSON.parse(stored?.payload_json ?? "{}") as { webhook?: Record<string, unknown> };
    const webhookPayload = parsedStored.webhook ?? {};
    assert.equal(webhookPayload.nodeId, "node-1");
    assert.equal(webhookPayload.status, "online");
    assert.equal("apiKey" in webhookPayload, false);
    assert.equal("localPath" in webhookPayload, false);
  });
});
