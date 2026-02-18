import type { Context, Hono } from "hono";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import net from "node:net";
import type { GatewayHttpDeps } from "../http.js";
import type { AgentRunInfo } from "../dashboard/types.js";
import {
  clampInt,
  listAgents,
  listAgentGraph,
  filterVisibleAgentRuns,
  filterVisibleAgentGraph,
  listNodes as listNodeRows,
  getNodeById as getNodeRowById,
  listJobRuns,
  listLlmSessions,
  listLlmMessages,
} from "../dashboard/queries.js";
import { listMcpGrants, listMcpProfiles, listMcpServers } from "../../mcp/store.js";
import { getNodeById as getNodeRecordById, setNodeStatus as setNodeRecordStatus } from "../../storage/nodes.js";
import {
  appendFederationAudit,
  appendFederationEvent,
  countIdentityKeysByScope,
  consumeFederationReplayNonce,
  createFederationTask,
  enqueueWebhookDelivery,
  federationPeerIdentityScope,
  getFederationEventById,
  getFederationEventByEnvelopeId,
  getFederationExportById,
  getFederationGrantProjectionForPeerResource,
  getIdentityKeyByScopeKid,
  getWebhookDeliveryById,
  getWebhookEndpointById,
  enqueueFederationOutbox,
  getFederationPeerById,
  getFederationTaskById,
  listFederationEvents,
  listFederationExports,
  listFederationGrants,
  listWebhookDeliveries,
  listWebhookDlq,
  listWebhookEndpoints,
  listWebhookSubscriptions,
  listFederationOutbox,
  listFederationPeers,
  listFederationTasks,
  listFederationAudit,
  markWebhookDlqReplayed,
  removeFederationExport,
  removeFederationGrant,
  removeWebhookEndpoint,
  removeWebhookSubscription,
  rotateIdentityKeyForScope,
  setIdentityKeyStatusByScope,
  setFederationPeerTrustState,
  type FederationExportResourceType,
  upsertFederationPeer,
  upsertFederationExport,
  upsertFederationGrant,
  upsertWebhookEndpoint,
  upsertWebhookSubscription,
  updateWebhookDeliveryStatus,
  type FederationOutboxStatus,
  type FederationPeerTrustState,
  type FederationTaskStatus,
  type WebhookDeliveryStatus,
  type WebhookEndpointOwnerScope,
  type WebhookEndpointSigningMode,
  type WebhookEndpointStatus,
  upsertIdentityKey,
  updateFederationTask,
} from "../../storage/federation.js";
import { parseNodePublicKey, verifyProtocolEnvelope } from "../../nodes/auth.js";
import type { FederationSignedEnvelope } from "../../federation/types.js";
import { evaluateFederationFirewall } from "../../federation/firewall.js";
import {
  buildWebhookCanonicalSigningInput,
  eventTypeMatchesFilter,
  type FederationWebhookEnvelope,
  verifyWebhookCanonicalInput,
} from "../../federation/webhook.js";
import { applySharedEventProjection } from "../../federation/sharing.js";
import { deleteCredential } from "../../secrets/credentials.js";
import { parseSecretReference } from "../../secrets/provider.js";

type McpEventApiRow = {
  id: string;
  server_id: string | null;
  profile_id: string | null;
  kind: string;
  payload_json: string;
  created_at: number;
};

const FEDERATION_ENVELOPE_MAX_SKEW_MS = 5 * 60_000;
const FEDERATION_KEY_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;
const FEDERATION_WEBHOOK_MAX_SKEW_MS = 5 * 60_000;
const FEDERATION_INGRESS_MAX_BODY_BYTES = parseEnvByteLimit("NEXUS_FEDERATION_INGRESS_MAX_BODY_BYTES", 256 * 1024);
const FEDERATION_WEBHOOK_MAX_BODY_BYTES = parseEnvByteLimit("NEXUS_FEDERATION_WEBHOOK_MAX_BODY_BYTES", 256 * 1024);

export function registerApiRoutes(app: Hono, deps: GatewayHttpDeps): void {
  app.get("/status", async (c) => c.json(await deps.getStatus()));
  const monetizationControlPlaneLocked = deps.runtimeProfile === "monetization";
  const writeFederationAudit = (
    params: {
      peerId?: string | null;
      eventType: string;
      decision?: "allow" | "deny" | "info" | null;
      actor?: string | null;
      traceId?: string | null;
      details?: Record<string, unknown>;
      nowMs?: number;
    },
  ): void => {
    if (!deps.db) return;
    appendFederationAudit(deps.db, {
      id: crypto.randomUUID(),
      peerId: params.peerId ?? null,
      eventType: params.eventType,
      decision: params.decision ?? null,
      actor: params.actor ?? null,
      traceId: params.traceId ?? null,
      details: params.details ?? {},
      nowMs: params.nowMs ?? Date.now(),
    });
  };
  const isFederationGloballyDisabled = (): boolean => deps.getFederationBreakglassState?.().globalDisable === true;

  app.get("/api/federation/status", async (c) => {
    const status = await deps.getStatus();
    const root = asObject(status);
    const federation = asObject(root.federation);
    return c.json({
      ...federation,
      timestamp: Date.now(),
    });
  });

  app.get("/api/federation/breakglass", async (c) => {
    return c.json({
      state: deps.getFederationBreakglassState?.() ?? { globalDisable: false },
      timestamp: Date.now(),
    });
  });

  app.post("/api/federation/breakglass/global", async (c) => {
    if (!deps.setFederationGlobalDisable) {
      return c.json({ error: "breakglass global disable is not available" }, 503);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const payload = asObject(body);
    const disabled = parseOptionalBoolean(payload.disabled);
    if (disabled == null) {
      return c.json({ error: "disabled (boolean) is required" }, 400);
    }
    const nowMs = Date.now();
    const state = deps.setFederationGlobalDisable(disabled);
    writeFederationAudit({
      eventType: "control.breakglass.global_disable",
      decision: "info",
      actor: "instance:gateway",
      details: { disabled },
      nowMs,
    });
    return c.json({ ok: true, state, timestamp: nowMs });
  });

  app.post("/api/federation/breakglass/pause_service", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const payload = asObject(body);
    const peerId = parseUnknownText(payload.peerId, 200);
    const paused = parseOptionalBoolean(payload.paused) ?? true;
    if (!peerId) return c.json({ error: "peerId is required" }, 400);
    const nowMs = Date.now();
    const ok = setFederationPeerTrustState(deps.db, {
      id: peerId,
      trustState: paused ? "quarantined" : "trusted",
      enabled: paused ? false : true,
      nowMs,
    });
    if (!ok) return c.json({ error: "peer not found" }, 404);
    writeFederationAudit({
      peerId,
      eventType: "control.breakglass.pause_service",
      decision: "info",
      actor: "instance:gateway",
      details: { paused },
      nowMs,
    });
    return c.json({ ok: true, peer: getFederationPeerById(deps.db, peerId), timestamp: nowMs });
  });

  app.post("/api/federation/breakglass/revoke_credential", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const payload = asObject(body);
    const id = parseUnknownText(payload.id, 200);
    if (!id) return c.json({ error: "id is required" }, 400);
    const nowMs = Date.now();
    const revoked = await deleteCredential({
      stateDir: deps.stateDir,
      id,
    });
    if (!revoked) return c.json({ error: "credential not found" }, 404);
    writeFederationAudit({
      eventType: "control.breakglass.revoke_credential",
      decision: "info",
      actor: "instance:gateway",
      details: { id },
      nowMs,
    });
    return c.json({ ok: true, revoked: id, timestamp: nowMs });
  });

  app.post("/api/federation/inbox", async (c) => {
    if (isFederationGloballyDisabled()) {
      return c.json({ error: "federation ingress is globally disabled" }, 503);
    }
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const parsedBody = await readJsonBodyLimited(c, FEDERATION_INGRESS_MAX_BODY_BYTES);
    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, parsedBody.status);
    const body = parsedBody.value;

    const envelope = parseFederationSignedEnvelope(body);
    if (!envelope) {
      return c.json({ error: "invalid signed envelope payload" }, 400);
    }

    const sourceHeader = c.req.header("x-nexus-instance-id");
    if (typeof sourceHeader === "string" && sourceHeader.trim().length > 0 && sourceHeader.trim() !== envelope.source) {
      return c.json({ error: "source header does not match envelope source" }, 400);
    }
    const kidHeader = c.req.header("x-nexus-kid");
    if (typeof kidHeader === "string" && kidHeader.trim().length > 0 && kidHeader.trim() !== envelope.kid) {
      return c.json({ error: "kid header does not match envelope kid" }, 400);
    }

    const nowMs = Date.now();
    const localInstanceId =
      typeof deps.federationLocalInstanceId === "string" ? deps.federationLocalInstanceId.trim() : "";
    if (localInstanceId && envelope.destination !== localInstanceId) {
      writeFederationAudit({
        eventType: "firewall.ingress",
        decision: "deny",
        actor: `peer:${envelope.source}`,
        traceId: envelope.traceId,
        details: {
          reason: "destination_mismatch",
          expectedDestination: localInstanceId,
          actualDestination: envelope.destination,
          methodOrEvent: envelope.methodOrEvent,
          envelopeId: envelope.envelopeId,
        },
        nowMs,
      });
      return c.json({ error: "envelope destination does not match local instance" }, 403);
    }
    if (Math.abs(nowMs - envelope.ts) > FEDERATION_ENVELOPE_MAX_SKEW_MS) {
      return c.json({ error: "envelope timestamp outside replay window" }, 401);
    }

    const peer = getFederationPeerById(deps.db, envelope.source);
    if (!peer) {
      writeFederationAudit({
        eventType: "firewall.ingress",
        decision: "deny",
        actor: `peer:${envelope.source}`,
        traceId: envelope.traceId,
        details: {
          reason: "unknown_peer_source",
          methodOrEvent: envelope.methodOrEvent,
          envelopeId: envelope.envelopeId,
        },
        nowMs,
      });
      return c.json({ error: "unknown peer source" }, 403);
    }
    if (!peer.enabled || peer.trustState !== "trusted") {
      writeFederationAudit({
        peerId: peer.id,
        eventType: "firewall.ingress",
        decision: "deny",
        actor: `peer:${envelope.source}`,
        traceId: envelope.traceId,
        details: {
          reason: !peer.enabled ? "peer_disabled" : `peer_not_trusted:${peer.trustState}`,
          methodOrEvent: envelope.methodOrEvent,
          envelopeId: envelope.envelopeId,
        },
        nowMs,
      });
      return c.json({ error: "peer is not trusted for federation ingress" }, 403);
    }
    const firewallDecision = evaluateFederationFirewall({
      direction: "ingress",
      methodOrEvent: envelope.methodOrEvent,
      peerEnabled: peer.enabled,
      peerTrustState: peer.trustState,
    });
    writeFederationAudit({
      peerId: peer.id,
      eventType: "firewall.ingress",
      decision: firewallDecision.decision,
      actor: `peer:${envelope.source}`,
      traceId: envelope.traceId,
      details: {
        reason: firewallDecision.reason,
        operation: firewallDecision.operation,
        methodOrEvent: firewallDecision.methodOrEvent,
        envelopeId: envelope.envelopeId,
      },
      nowMs,
    });
    if (!firewallDecision.allowed) {
      return c.json({ error: `federation ingress blocked by firewall: ${firewallDecision.reason}` }, 403);
    }

    const peerKeyScope = federationPeerIdentityScope(peer.id);
    const peerIdentityKey = getIdentityKeyByScopeKid(deps.db, {
      scope: peerKeyScope,
      kid: envelope.kid,
      nowMs,
    });
    const existingPeerKeyCount = countIdentityKeysByScope(deps.db, peerKeyScope);
    const legacyMigrationAllowed = !peerIdentityKey && existingPeerKeyCount === 0;
    const storedPeerKey = peerIdentityKey ? parseNodePublicKey(peerIdentityKey.publicKey) : null;
    if (peerIdentityKey && !storedPeerKey) {
      return c.json({ error: "peer signing key is invalid" }, 403);
    }
    const legacyPeerKey = legacyMigrationAllowed ? parseNodePublicKey(peer.signingKey) : null;
    const verificationKey = storedPeerKey ?? legacyPeerKey;
    if (!verificationKey) {
      return c.json({ error: "unknown or inactive peer key id" }, 401);
    }

    const publicKeyHeader = c.req.header("x-nexus-public-key");
    if (typeof publicKeyHeader === "string" && publicKeyHeader.trim().length > 0) {
      const headerPeerKey = parseNodePublicKey(publicKeyHeader);
      if (!headerPeerKey || headerPeerKey.fingerprint !== verificationKey.fingerprint) {
        return c.json({ error: "peer public key mismatch" }, 401);
      }
    }

    if (!verifyProtocolEnvelope(envelope as unknown as Record<string, unknown>, verificationKey.key)) {
      return c.json({ error: "invalid envelope signature" }, 401);
    }
    if (!peerIdentityKey && legacyPeerKey) {
      upsertIdentityKey(deps.db, {
        scope: peerKeyScope,
        kid: envelope.kid,
        publicKey: legacyPeerKey.raw,
        status: "active",
        notBefore: nowMs,
        metadata: { source: "peer_signing_key_migration_verified" },
        nowMs,
      });
    }

    const existing = getFederationEventByEnvelopeId(deps.db, {
      envelopeId: envelope.envelopeId,
      direction: "inbound",
    });
    if (existing) {
      return c.json(
        {
          ok: true,
          duplicate: true,
          eventId: existing.id,
          envelopeId: existing.envelopeId,
          timestamp: nowMs,
        },
        409,
      );
    }

    const nonceResult = consumeFederationReplayNonce(deps.db, {
      sourceInstance: envelope.source,
      nonce: envelope.nonce,
      keyId: envelope.kid,
      envelopeId: envelope.envelopeId,
      traceId: envelope.traceId,
      ttlMs: FEDERATION_ENVELOPE_MAX_SKEW_MS,
      nowMs,
    });
    if (!nonceResult.accepted) {
      const replayedEnvelope = getFederationEventByEnvelopeId(deps.db, {
        envelopeId: envelope.envelopeId,
        direction: "inbound",
      });
      if (replayedEnvelope) {
        return c.json(
          {
            ok: true,
            duplicate: true,
            eventId: replayedEnvelope.id,
            envelopeId: replayedEnvelope.envelopeId,
            timestamp: nowMs,
          },
          409,
        );
      }
      return c.json(
        {
          error: "replayed nonce detected",
          envelopeId: envelope.envelopeId,
          timestamp: nowMs,
        },
        401,
      );
    }

    const eventId = crypto.randomUUID();
    appendFederationEvent(deps.db, {
      id: eventId,
      peerId: peer.id,
      eventType: envelope.methodOrEvent,
      direction: "inbound",
      envelopeId: envelope.envelopeId,
      payload: envelope.payload,
      traceId: envelope.traceId ?? null,
      nowMs,
    });

    const taskOutcome = applyInboxTaskMutation(deps.db, peer.id, envelope, nowMs);

    return c.json(
      {
        ok: true,
        eventId,
        envelopeId: envelope.envelopeId,
        taskId: taskOutcome.taskId,
        duplicateTask: taskOutcome.duplicateTask,
        taskUpdated: taskOutcome.taskUpdated,
        timestamp: nowMs,
      },
      202,
    );
  });

  app.get("/api/federation/peers", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 200;
    const peers = listFederationPeers(deps.db, limit);
    return c.json({ peers, timestamp: Date.now() });
  });

  app.get("/api/federation/peers/:id", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const id = String(c.req.param("id") ?? "").trim();
    if (!id) return c.json({ error: "id is required" }, 400);
    const peer = getFederationPeerById(deps.db, id);
    if (!peer) return c.json({ error: "peer not found" }, 404);
    return c.json({ peer, timestamp: Date.now() });
  });

  app.post("/api/federation/peers", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    if (monetizationControlPlaneLocked) {
      return c.json({ error: "federation peer mutations are disabled in monetization profile" }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const payload = asObject(body);
    const id = String(payload.id ?? "").trim();
    const label = String(payload.label ?? "").trim();
    const endpoint = String(payload.endpoint ?? "").trim();
    const signingKey = String(payload.signingKey ?? "").trim();
    const signingKeyKid = parseUnknownText(payload.signingKeyKid, 128) ?? "kid-initial";
    const trustState = parseFederationPeerTrustState(payload.trustState);
    const enabled = parseOptionalBoolean(payload.enabled);
    if (!id || !label || !endpoint || !signingKey) {
      return c.json({ error: "id, label, endpoint, signingKey are required" }, 400);
    }
    const parsedSigningKey = parseNodePublicKey(signingKey);
    if (!parsedSigningKey) {
      return c.json({ error: "signingKey must be a valid Ed25519 public key" }, 400);
    }
    if (!trustState) {
      return c.json({ error: "trustState must be one of pending|trusted|revoked|quarantined" }, 400);
    }
    const nowMs = Date.now();
    upsertFederationPeer(deps.db, {
      id,
      label,
      endpoint,
      signingKey: parsedSigningKey.raw,
      trustState,
      enabled: enabled ?? true,
      metadata: asObject(payload.metadata),
      nowMs,
    });
    const peerKeyScope = federationPeerIdentityScope(id);
    const keyStatus = trustState === "revoked" || trustState === "quarantined" ? "revoked" : "active";
    if (keyStatus === "active") {
      rotateIdentityKeyForScope(deps.db, {
        scope: peerKeyScope,
        kid: signingKeyKid,
        publicKey: parsedSigningKey.raw,
        metadata: { source: "peer_upsert_rotate" },
        overlapMs: FEDERATION_KEY_ROTATION_OVERLAP_MS,
        nowMs,
      });
    } else {
      upsertIdentityKey(deps.db, {
        scope: peerKeyScope,
        kid: signingKeyKid,
        publicKey: parsedSigningKey.raw,
        status: "revoked",
        notBefore: nowMs,
        revokedAt: nowMs,
        metadata: { source: "peer_upsert_revoked" },
        nowMs,
      });
      setIdentityKeyStatusByScope(deps.db, {
        scope: peerKeyScope,
        status: "revoked",
        revokedAt: nowMs,
        nowMs,
      });
    }
    const peer = getFederationPeerById(deps.db, id);
    writeFederationAudit({
      peerId: id,
      eventType: "control.peer.upsert",
      decision: "info",
      actor: "instance:gateway",
      details: {
        trustState,
        enabled: enabled ?? true,
        endpoint,
      },
      nowMs,
    });
    return c.json({ ok: true, peer, signingKeyKid, timestamp: nowMs });
  });

  app.post("/api/federation/peers/:id/trust", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    if (monetizationControlPlaneLocked) {
      return c.json({ error: "peer trust mutations are disabled in monetization profile" }, 403);
    }
    const id = String(c.req.param("id") ?? "").trim();
    if (!id) return c.json({ error: "id is required" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const payload = asObject(body);
    const trustState = parseFederationPeerTrustState(payload.trustState);
    const enabled = parseOptionalBoolean(payload.enabled);
    if (!trustState) {
      return c.json({ error: "trustState must be one of pending|trusted|revoked|quarantined" }, 400);
    }
    const nowMs = Date.now();
    const ok = setFederationPeerTrustState(deps.db, {
      id,
      trustState,
      enabled: enabled ?? undefined,
      nowMs,
    });
    if (!ok) return c.json({ error: "peer not found" }, 404);
    const keyStatus = trustState === "revoked" || trustState === "quarantined" ? "revoked" : "active";
    setIdentityKeyStatusByScope(deps.db, {
      scope: federationPeerIdentityScope(id),
      status: keyStatus,
      revokedAt: keyStatus === "revoked" ? nowMs : null,
      nowMs,
    });
    const peer = getFederationPeerById(deps.db, id);
    writeFederationAudit({
      peerId: id,
      eventType: "control.peer.trust_update",
      decision: "info",
      actor: "instance:gateway",
      details: {
        trustState,
        enabled: enabled ?? undefined,
      },
      nowMs,
    });
    return c.json({ ok: true, peer, timestamp: nowMs });
  });

  app.get("/api/federation/tasks", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 200;
    const tasks = listFederationTasks(deps.db, limit);
    return c.json({ tasks, timestamp: Date.now() });
  });

  app.get("/api/federation/tasks/:id", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const id = String(c.req.param("id") ?? "").trim();
    if (!id) return c.json({ error: "id is required" }, 400);
    const task = getFederationTaskById(deps.db, id);
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ task, timestamp: Date.now() });
  });

  app.post("/api/federation/tasks", async (c) => {
    if (isFederationGloballyDisabled()) {
      return c.json({ error: "federation egress is globally disabled" }, 503);
    }
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const payload = asObject(body);
    const peerId = String(payload.peerId ?? "").trim();
    const method = String(payload.method ?? "").trim();
    if (!peerId || !method) {
      return c.json({ error: "peerId and method are required" }, 400);
    }
    const peer = getFederationPeerById(deps.db, peerId);
    if (!peer) return c.json({ error: "peer not found" }, 404);
    const nowMs = Date.now();
    const firewallDecision = evaluateFederationFirewall({
      direction: "egress",
      methodOrEvent: method,
      peerEnabled: peer.enabled,
      peerTrustState: peer.trustState,
    });
    writeFederationAudit({
      peerId: peer.id,
      eventType: "firewall.egress",
      decision: firewallDecision.decision,
      actor: "instance:gateway",
      details: {
        reason: firewallDecision.reason,
        operation: firewallDecision.operation,
        methodOrEvent: firewallDecision.methodOrEvent,
      },
      nowMs,
    });
    if (!firewallDecision.allowed) {
      return c.json({ error: `federation egress blocked by firewall: ${firewallDecision.reason}` }, 403);
    }
    const normalizedMethod = method.trim().toLowerCase();
    const requestPayload = asObject(payload.request);
    if (normalizedMethod === "task_status" || normalizedMethod === "task.status") {
      const referencedTaskId =
        parseUnknownText(payload.taskId, 256) ??
        parseUnknownText(requestPayload.taskId, 256) ??
        parseUnknownText(payload.id, 256) ??
        crypto.randomUUID();
      const status = parseFederationTaskStatus(payload.status) ?? parseFederationTaskStatus(requestPayload.status);
      if (!status) {
        return c.json({ error: "task_status requires status (pending|running|completed|failed|cancelled)" }, 400);
      }
      const resultPayload = parseOptionalRecord(payload.result) ?? parseOptionalRecord(requestPayload.result);
      const errorPayload = parseOptionalRecord(payload.error) ?? parseOptionalRecord(requestPayload.error);
      const idempotencyKey = parseUnknownText(payload.idempotencyKey, 256) ?? referencedTaskId;
      enqueueFederationOutbox(deps.db, {
        id: crypto.randomUUID(),
        peerId,
        transportKind: "federation_http",
        envelope: {
          taskId: referencedTaskId,
          method: "task_status",
          status,
          result: resultPayload ?? undefined,
          error: errorPayload ?? undefined,
        },
        traceId: idempotencyKey,
        nowMs,
      });
      const existingTask = getFederationTaskById(deps.db, referencedTaskId);
      if (existingTask) {
        updateFederationTask(deps.db, {
          id: referencedTaskId,
          status,
          result: resultPayload,
          error: errorPayload,
          nowMs,
        });
      }
      const task = getFederationTaskById(deps.db, referencedTaskId);
      writeFederationAudit({
        peerId,
        eventType: "control.task.status_emit",
        decision: "info",
        actor: "instance:gateway",
        traceId: referencedTaskId,
        details: {
          method: "task_status",
          status,
        },
        nowMs,
      });
      return c.json({ ok: true, taskId: referencedTaskId, status, task, timestamp: nowMs });
    }

    const taskId = String(payload.id ?? "").trim() || crypto.randomUUID();
    createFederationTask(deps.db, {
      id: taskId,
      peerId,
      method,
      request: requestPayload,
      idempotencyKey: typeof payload.idempotencyKey === "string" ? parseOptionalText(payload.idempotencyKey, 256) : null,
      nowMs,
    });
    enqueueFederationOutbox(deps.db, {
      id: crypto.randomUUID(),
      peerId,
      transportKind: "federation_http",
      envelope: {
        taskId,
        method,
        request: requestPayload,
      },
      traceId: taskId,
      nowMs,
    });
    const task = getFederationTaskById(deps.db, taskId);
    writeFederationAudit({
      peerId,
      eventType: "control.task.submit",
      decision: "info",
      actor: "instance:gateway",
      traceId: taskId,
      details: {
        method,
      },
      nowMs,
    });
    return c.json({ ok: true, task, timestamp: nowMs });
  });

  app.post("/api/federation/tasks/:id/status", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const id = String(c.req.param("id") ?? "").trim();
    if (!id) return c.json({ error: "id is required" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const payload = asObject(body);
    const status = parseFederationTaskStatus(payload.status);
    if (!status) {
      return c.json({ error: "status must be one of pending|running|completed|failed|cancelled" }, 400);
    }
    const nowMs = Date.now();
    const ok = updateFederationTask(deps.db, {
      id,
      status,
      result: parseOptionalRecord(payload.result),
      error: parseOptionalRecord(payload.error),
      nowMs,
    });
    if (!ok) return c.json({ error: "task not found" }, 404);
    const task = getFederationTaskById(deps.db, id);
    writeFederationAudit({
      peerId: task?.peerId ?? null,
      eventType: "control.task.status_update",
      decision: "info",
      actor: "instance:gateway",
      traceId: id,
      details: {
        status,
      },
      nowMs,
    });
    return c.json({ ok: true, task, timestamp: nowMs });
  });

  app.get("/api/federation/outbox", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 200;
    const status = parseFederationOutboxStatus(c.req.query("status"));
    const outbox = listFederationOutbox(deps.db, {
      limit,
      status: status ?? undefined,
    });
    return c.json({ outbox, timestamp: Date.now() });
  });

  app.get("/api/federation/audit", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 200;
    const peerId = parseOptionalText(c.req.query("peerId"), 200);
    const rows = listFederationAudit(deps.db, {
      limit,
      peerId: peerId ?? undefined,
    });
    return c.json({ rows, timestamp: Date.now() });
  });

  app.get("/api/federation/events", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 200;
    const peerId = parseOptionalText(c.req.query("peerId"), 200);
    const direction = parseFederationEventDirection(c.req.query("direction"));
    const events = listFederationEvents(deps.db, {
      limit,
      peerId: peerId ?? undefined,
      direction: direction ?? undefined,
    });
    return c.json({ events, timestamp: Date.now() });
  });

  app.get("/api/federation/exports", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 200;
    const rows = listFederationExports(deps.db, limit);
    return c.json({ exports: rows, timestamp: Date.now() });
  });

  app.post("/api/federation/exports", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    if (monetizationControlPlaneLocked) {
      return c.json({ error: "federation export mutations are disabled in monetization profile" }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const payload = asObject(body);
    const id = parseUnknownText(payload.id, 200) ?? crypto.randomUUID();
    const resourceType = parseFederationExportResourceType(payload.resourceType);
    if (!resourceType) {
      return c.json({ error: "resourceType must be one of node_pool|data_intake|blackboard|mcp" }, 400);
    }
    const nowMs = Date.now();
    upsertFederationExport(deps.db, {
      id,
      resourceType,
      resourceSelector: parseOptionalRecord(payload.resourceSelector) ?? {},
      projection: parseOptionalRecord(payload.projection) ?? {},
      enabled: parseOptionalBoolean(payload.enabled) ?? true,
      nowMs,
    });
    const row = getFederationExportById(deps.db, id);
    writeFederationAudit({
      eventType: "control.export.upsert",
      decision: "info",
      actor: "instance:gateway",
      details: {
        exportId: id,
        resourceType,
      },
      nowMs,
    });
    return c.json({ ok: true, export: row, timestamp: nowMs });
  });

  app.delete("/api/federation/exports/:id", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    if (monetizationControlPlaneLocked) {
      return c.json({ error: "federation export mutations are disabled in monetization profile" }, 403);
    }
    const id = parseOptionalText(c.req.param("id"), 200);
    if (!id) return c.json({ error: "id is required" }, 400);
    const ok = removeFederationExport(deps.db, id);
    if (!ok) return c.json({ error: "export not found" }, 404);
    const nowMs = Date.now();
    writeFederationAudit({
      eventType: "control.export.remove",
      decision: "info",
      actor: "instance:gateway",
      details: { exportId: id },
      nowMs,
    });
    return c.json({ ok: true, timestamp: nowMs });
  });

  app.get("/api/federation/grants", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 200;
    const peerId = parseOptionalText(c.req.query("peerId"), 200);
    const enabledOnly = parseBooleanQuery(c.req.query("enabledOnly"), true);
    const rows = listFederationGrants(deps.db, {
      limit,
      peerId: peerId ?? undefined,
      enabledOnly,
    });
    return c.json({ grants: rows, timestamp: Date.now() });
  });

  app.post("/api/federation/grants", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    if (monetizationControlPlaneLocked) {
      return c.json({ error: "federation grant mutations are disabled in monetization profile" }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const payload = asObject(body);
    const id = parseUnknownText(payload.id, 200) ?? crypto.randomUUID();
    const peerId = parseUnknownText(payload.peerId, 200);
    const exportId = parseUnknownText(payload.exportId, 200);
    if (!peerId || !exportId) {
      return c.json({ error: "peerId and exportId are required" }, 400);
    }
    if (!getFederationPeerById(deps.db, peerId)) {
      return c.json({ error: "peer not found" }, 404);
    }
    if (!getFederationExportById(deps.db, exportId)) {
      return c.json({ error: "export not found" }, 404);
    }
    const nowMs = Date.now();
    upsertFederationGrant(deps.db, {
      id,
      peerId,
      exportId,
      permission: parseUnknownText(payload.permission, 64) ?? "read",
      sensitivityCeiling: parseUnknownText(payload.sensitivityCeiling, 64) ?? "internal",
      enabled: parseOptionalBoolean(payload.enabled) ?? true,
      nowMs,
    });
    const row = listFederationGrants(deps.db, {
      limit: 1,
      peerId,
    }).find((candidate) => candidate.exportId === exportId) ?? null;
    writeFederationAudit({
      peerId,
      eventType: "control.grant.upsert",
      decision: "info",
      actor: "instance:gateway",
      details: {
        grantId: id,
        exportId,
      },
      nowMs,
    });
    return c.json({ ok: true, grant: row, timestamp: nowMs });
  });

  app.delete("/api/federation/grants/:id", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    if (monetizationControlPlaneLocked) {
      return c.json({ error: "federation grant mutations are disabled in monetization profile" }, 403);
    }
    const id = parseOptionalText(c.req.param("id"), 200);
    if (!id) return c.json({ error: "id is required" }, 400);
    const ok = removeFederationGrant(deps.db, id);
    if (!ok) return c.json({ error: "grant not found" }, 404);
    const nowMs = Date.now();
    writeFederationAudit({
      eventType: "control.grant.remove",
      decision: "info",
      actor: "instance:gateway",
      details: { grantId: id },
      nowMs,
    });
    return c.json({ ok: true, timestamp: nowMs });
  });

  app.get("/api/webhooks/endpoints", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 200;
    const ownerScope = parseWebhookEndpointOwnerScope(c.req.query("ownerScope"));
    const peerId = parseOptionalText(c.req.query("peerId"), 200);
    const rows = listWebhookEndpoints(deps.db, {
      limit,
      ownerScope: ownerScope ?? undefined,
      peerId: peerId ?? undefined,
    });
    return c.json({ endpoints: rows, timestamp: Date.now() });
  });

  app.post("/api/webhooks/endpoints", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    if (monetizationControlPlaneLocked) {
      return c.json({ error: "webhook endpoint mutations are disabled in monetization profile" }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const payload = asObject(body);
    const id = parseUnknownText(payload.id, 200) ?? crypto.randomUUID();
    const url = parseUnknownText(payload.url, 4096);
    if (!url) return c.json({ error: "url is required" }, 400);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return c.json({ error: "url must be valid" }, 400);
    }
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return c.json({ error: "url protocol must be http or https" }, 400);
    }
    const allowInsecureHttp = deps.federationAllowInsecureWebhookHttpDev === true;
    if (parsedUrl.protocol === "http:" && !allowInsecureHttp) {
      return c.json({ error: "http webhook urls are disabled by policy; use https" }, 400);
    }
    if (isUnsafeWebhookHostname(parsedUrl.hostname)) {
      return c.json({ error: "webhook hostname is not allowed" }, 400);
    }

    const ownerScope = parseWebhookEndpointOwnerScope(payload.ownerScope) ?? "local";
    const peerId = parseUnknownText(payload.peerId, 200);
    const federatedOnly = deps.federationWebhooksFederatedOnly !== false;
    const externalEnabled = deps.federationWebhooksExternalEnabled === true;
    if (ownerScope !== "federation_peer" && federatedOnly && !externalEnabled) {
      return c.json({ error: "external webhook endpoints are disabled in federated_only mode" }, 403);
    }
    if (ownerScope === "federation_peer") {
      if (!peerId) return c.json({ error: "peerId is required for federation_peer endpoints" }, 400);
      const peer = getFederationPeerById(deps.db, peerId);
      if (!peer) return c.json({ error: "peer not found" }, 404);
      try {
        const peerUrl = new URL(peer.endpoint);
        if (peerUrl.hostname.toLowerCase() !== parsedUrl.hostname.toLowerCase()) {
          return c.json({ error: "webhook host must match peer endpoint host" }, 400);
        }
      } catch {
        return c.json({ error: "peer endpoint is invalid" }, 400);
      }
    }
    const signingMode = parseWebhookEndpointSigningMode(payload.signingMode) ?? "ed25519";
    const secretRef = parseUnknownText(payload.secretRef, 256);
    if (ownerScope === "federation_peer" && signingMode !== "ed25519") {
      return c.json({ error: "federation peer endpoints must use ed25519 signing" }, 400);
    }
    if (signingMode === "hmac") {
      if (!secretRef) return c.json({ error: "secretRef is required for hmac signing mode" }, 400);
      if (!parseSecretReference(secretRef)) {
        return c.json({ error: "secretRef must be a valid secret reference ({{secret:provider/path#field}})" }, 400);
      }
    } else if (secretRef) {
      return c.json({ error: "secretRef is only supported when signingMode=hmac" }, 400);
    }
    const status = parseWebhookEndpointStatus(payload.status) ?? "active";
    const eventFilter = parseWebhookEventFilter(payload.eventFilter);
    const nowMs = Date.now();
    upsertWebhookEndpoint(deps.db, {
      id,
      ownerScope,
      peerId: peerId ?? null,
      url: parsedUrl.toString(),
      eventFilter,
      signingMode,
      secretRef: secretRef ?? null,
      enabled: parseOptionalBoolean(payload.enabled) ?? true,
      status,
      metadata: parseOptionalRecord(payload.metadata) ?? {},
      nowMs,
    });
    const endpoint = getWebhookEndpointById(deps.db, id);
    writeFederationAudit({
      peerId: endpoint?.peerId ?? null,
      eventType: "control.webhook_endpoint.upsert",
      decision: "info",
      actor: "instance:gateway",
      details: {
        endpointId: id,
        ownerScope,
        url: parsedUrl.toString(),
      },
      nowMs,
    });
    return c.json({ ok: true, endpoint, timestamp: nowMs });
  });

  app.delete("/api/webhooks/endpoints/:id", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    if (monetizationControlPlaneLocked) {
      return c.json({ error: "webhook endpoint mutations are disabled in monetization profile" }, 403);
    }
    const id = parseOptionalText(c.req.param("id"), 200);
    if (!id) return c.json({ error: "id is required" }, 400);
    const ok = removeWebhookEndpoint(deps.db, id);
    if (!ok) return c.json({ error: "endpoint not found" }, 404);
    const nowMs = Date.now();
    writeFederationAudit({
      eventType: "control.webhook_endpoint.remove",
      decision: "info",
      actor: "instance:gateway",
      details: { endpointId: id },
      nowMs,
    });
    return c.json({ ok: true, timestamp: nowMs });
  });

  app.get("/api/webhooks/subscriptions", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const limit = clampInt(c.req.query("limit"), 1, 1000) ?? 500;
    const endpointId = parseOptionalText(c.req.query("endpointId"), 200);
    const enabledOnly = parseBooleanQuery(c.req.query("enabledOnly"), true);
    const rows = listWebhookSubscriptions(deps.db, {
      limit,
      endpointId: endpointId ?? undefined,
      enabledOnly,
    });
    return c.json({ subscriptions: rows, timestamp: Date.now() });
  });

  app.post("/api/webhooks/subscriptions", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    if (monetizationControlPlaneLocked) {
      return c.json({ error: "webhook subscription mutations are disabled in monetization profile" }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const payload = asObject(body);
    const id = parseUnknownText(payload.id, 200) ?? crypto.randomUUID();
    const endpointId = parseUnknownText(payload.endpointId, 200);
    const eventType = parseUnknownText(payload.eventType, 200);
    if (!endpointId || !eventType) {
      return c.json({ error: "endpointId and eventType are required" }, 400);
    }
    if (!getWebhookEndpointById(deps.db, endpointId)) {
      return c.json({ error: "endpoint not found" }, 404);
    }
    const nowMs = Date.now();
    upsertWebhookSubscription(deps.db, {
      id,
      endpointId,
      eventType,
      enabled: parseOptionalBoolean(payload.enabled) ?? true,
      nowMs,
    });
    const row = listWebhookSubscriptions(deps.db, {
      endpointId,
      limit: 500,
    }).find((candidate) => candidate.eventType === eventType) ?? null;
    writeFederationAudit({
      peerId: getWebhookEndpointById(deps.db, endpointId)?.peerId ?? null,
      eventType: "control.webhook_subscription.upsert",
      decision: "info",
      actor: "instance:gateway",
      details: {
        subscriptionId: id,
        endpointId,
        eventType,
      },
      nowMs,
    });
    return c.json({ ok: true, subscription: row, timestamp: nowMs });
  });

  app.delete("/api/webhooks/subscriptions/:id", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    if (monetizationControlPlaneLocked) {
      return c.json({ error: "webhook subscription mutations are disabled in monetization profile" }, 403);
    }
    const id = parseOptionalText(c.req.param("id"), 200);
    if (!id) return c.json({ error: "id is required" }, 400);
    const ok = removeWebhookSubscription(deps.db, id);
    if (!ok) return c.json({ error: "subscription not found" }, 404);
    const nowMs = Date.now();
    writeFederationAudit({
      eventType: "control.webhook_subscription.remove",
      decision: "info",
      actor: "instance:gateway",
      details: { subscriptionId: id },
      nowMs,
    });
    return c.json({ ok: true, timestamp: nowMs });
  });

  app.get("/api/webhooks/deliveries", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 200;
    const endpointId = parseOptionalText(c.req.query("endpointId"), 200);
    const status = parseWebhookDeliveryStatus(c.req.query("status"));
    const rows = listWebhookDeliveries(deps.db, {
      limit,
      endpointId: endpointId ?? undefined,
      status: status ?? undefined,
    });
    return c.json({ deliveries: rows, timestamp: Date.now() });
  });

  app.post("/api/webhooks/deliveries/:id/replay", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    if (monetizationControlPlaneLocked) {
      return c.json({ error: "webhook replay control is disabled in monetization profile" }, 403);
    }
    const id = parseOptionalText(c.req.param("id"), 200);
    if (!id) return c.json({ error: "id is required" }, 400);
    const row = getWebhookDeliveryById(deps.db, id);
    if (!row) return c.json({ error: "delivery not found" }, 404);
    const nowMs = Date.now();
    updateWebhookDeliveryStatus(deps.db, {
      id: row.id,
      status: "pending",
      attempts: 0,
      responseCode: null,
      responseBody: null,
      nextAttemptAt: nowMs,
      lastAttemptAt: null,
      nowMs,
    });
    const dlqRows = listWebhookDlq(deps.db, 200);
    for (const dlq of dlqRows) {
      if (dlq.deliveryId === row.id && dlq.replayedAt == null) {
        markWebhookDlqReplayed(deps.db, dlq.id, nowMs);
      }
    }
    writeFederationAudit({
      peerId: getWebhookEndpointById(deps.db, row.endpointId)?.peerId ?? null,
      eventType: "control.webhook_delivery.replay",
      decision: "info",
      actor: "instance:gateway",
      traceId: row.traceId,
      details: {
        deliveryId: row.id,
      },
      nowMs,
    });
    return c.json({ ok: true, deliveryId: id, timestamp: nowMs });
  });

  app.post("/api/webhooks/dispatch", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    if (monetizationControlPlaneLocked) {
      return c.json({ error: "manual webhook dispatch is disabled in monetization profile" }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const payload = asObject(body);
    const endpointId = parseUnknownText(payload.endpointId, 200);
    const eventId = parseUnknownText(payload.eventId, 200);
    if (!endpointId || !eventId) {
      return c.json({ error: "endpointId and eventId are required" }, 400);
    }
    if (!getWebhookEndpointById(deps.db, endpointId)) return c.json({ error: "endpoint not found" }, 404);
    if (!getFederationEventById(deps.db, eventId)) return c.json({ error: "event not found" }, 404);
    const deliveryId = parseUnknownText(payload.id, 200) ?? crypto.randomUUID();
    enqueueWebhookDelivery(deps.db, {
      id: deliveryId,
      endpointId,
      eventId,
      traceId: parseUnknownText(payload.traceId, 200) ?? eventId,
      nowMs: Date.now(),
    });
    writeFederationAudit({
      peerId: getWebhookEndpointById(deps.db, endpointId)?.peerId ?? null,
      eventType: "control.webhook_delivery.enqueue",
      decision: "info",
      actor: "instance:gateway",
      traceId: eventId,
      details: {
        deliveryId,
        endpointId,
        eventId,
      },
      nowMs: Date.now(),
    });
    return c.json({ ok: true, deliveryId, timestamp: Date.now() }, 202);
  });

  app.get("/api/webhooks/dlq", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 200;
    const rows = listWebhookDlq(deps.db, limit);
    return c.json({ rows, timestamp: Date.now() });
  });

  app.post("/federation-webhook", async (c) => {
    if (isFederationGloballyDisabled()) {
      return c.json({ error: "federation webhook ingress is globally disabled" }, 503);
    }
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const parsedBody = await readJsonBodyLimited(c, FEDERATION_WEBHOOK_MAX_BODY_BYTES);
    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, parsedBody.status);
    const bodyText = parsedBody.text;
    const bodyJson = parsedBody.value;
    const envelope = parseFederationWebhookEnvelope(bodyJson);
    if (!envelope) return c.json({ error: "invalid webhook envelope" }, 400);

    const eventIdHeader = c.req.header("x-nexus-event-id");
    const timestampHeader = c.req.header("x-nexus-timestamp");
    const nonceHeader = c.req.header("x-nexus-nonce");
    const signatureHeader = c.req.header("x-nexus-signature");
    const keyIdHeader = c.req.header("x-nexus-key-id");
    if (!eventIdHeader || !timestampHeader || !nonceHeader || !signatureHeader || !keyIdHeader) {
      return c.json({ error: "missing required webhook signature headers" }, 401);
    }
    if (eventIdHeader !== envelope.eventId) return c.json({ error: "eventId header mismatch" }, 400);
    if (nonceHeader !== envelope.nonce) return c.json({ error: "nonce header mismatch" }, 400);
    if (!/^\d+$/.test(timestampHeader)) return c.json({ error: "invalid timestamp header" }, 400);
    const timestampMs = Number(timestampHeader);
    if (!Number.isFinite(timestampMs)) return c.json({ error: "invalid timestamp header" }, 400);
    if (Math.abs(Date.now() - timestampMs) > FEDERATION_WEBHOOK_MAX_SKEW_MS) {
      return c.json({ error: "timestamp outside replay window" }, 401);
    }
    if (Math.abs(timestampMs - envelope.ts) > 1_000) {
      return c.json({ error: "timestamp header/body mismatch" }, 400);
    }

    const sourceHeader = c.req.header("x-nexus-instance-id");
    if (sourceHeader && sourceHeader.trim() && sourceHeader.trim() !== envelope.sourceInstance) {
      return c.json({ error: "source header mismatch" }, 400);
    }
    const peer = getFederationPeerById(deps.db, envelope.sourceInstance);
    if (!peer || !peer.enabled || peer.trustState !== "trusted") {
      return c.json({ error: "peer is not trusted for webhook ingress" }, 403);
    }

    const firewallDecision = evaluateFederationFirewall({
      direction: "ingress",
      methodOrEvent: "webhook.deliver",
      peerEnabled: peer.enabled,
      peerTrustState: peer.trustState,
    });
    writeFederationAudit({
      peerId: peer.id,
      eventType: "firewall.ingress",
      decision: firewallDecision.decision,
      actor: `peer:${peer.id}`,
      traceId: envelope.traceId,
      details: {
        reason: firewallDecision.reason,
        operation: firewallDecision.operation,
        methodOrEvent: firewallDecision.methodOrEvent,
        eventId: envelope.eventId,
      },
      nowMs: Date.now(),
    });
    if (!firewallDecision.allowed) {
      return c.json({ error: `federation webhook ingress blocked by firewall: ${firewallDecision.reason}` }, 403);
    }

    const keyScope = federationPeerIdentityScope(peer.id);
    const peerKeyRow = getIdentityKeyByScopeKid(deps.db, {
      scope: keyScope,
      kid: keyIdHeader,
      nowMs: Date.now(),
    });
    const existingPeerKeyCount = countIdentityKeysByScope(deps.db, keyScope);
    const legacyKeyAllowed = !peerKeyRow && existingPeerKeyCount === 0;
    const activePeerKey = peerKeyRow
      ? parseNodePublicKey(peerKeyRow.publicKey)
      : legacyKeyAllowed
        ? parseNodePublicKey(peer.signingKey)
        : null;
    if (!activePeerKey) return c.json({ error: "unknown peer signing key" }, 401);

    const requestPath = new URL(c.req.url).pathname;
    const canonical = buildWebhookCanonicalSigningInput({
      method: "POST",
      path: requestPath,
      timestamp: timestampHeader,
      nonce: nonceHeader,
      eventId: envelope.eventId,
      bodyBytes: bodyText,
    });
    if (!verifyWebhookCanonicalInput({
      input: canonical,
      signatureHeader,
      publicKey: activePeerKey.key,
    })) {
      return c.json({ error: "invalid webhook signature" }, 401);
    }

    const nonceResult = consumeFederationReplayNonce(deps.db, {
      sourceInstance: envelope.sourceInstance,
      nonce: envelope.nonce,
      keyId: keyIdHeader,
      envelopeId: envelope.eventId,
      traceId: envelope.traceId,
      ttlMs: FEDERATION_WEBHOOK_MAX_SKEW_MS,
      nowMs: Date.now(),
    });
    if (!nonceResult.accepted) {
      return c.json({ ok: true, duplicate: true, eventId: envelope.eventId, timestamp: Date.now() }, 409);
    }

    const existing = getFederationEventByEnvelopeId(deps.db, {
      envelopeId: envelope.eventId,
      direction: "inbound",
    });
    if (existing) {
      return c.json({ ok: true, duplicate: true, eventId: envelope.eventId, timestamp: Date.now() }, 409);
    }

    const endpoint = getWebhookEndpointById(deps.db, envelope.destination.endpointId);
    if (!endpoint || !endpoint.enabled || endpoint.status !== "active") {
      return c.json({ error: "endpoint is not active" }, 410);
    }
    if (endpoint.ownerScope === "federation_peer" && endpoint.peerId !== peer.id) {
      return c.json({ error: "endpoint peer binding mismatch" }, 403);
    }
    const subscriptions = listWebhookSubscriptions(deps.db, {
      endpointId: endpoint.id,
      enabledOnly: true,
      limit: 500,
    });
    if (subscriptions.length > 0) {
      const match = subscriptions.some((sub) => eventTypeMatchesFilter(envelope.kind, sub.eventType));
      if (!match) return c.json({ error: "no matching subscription for event kind" }, 403);
    }

    const resourceType = mapSharedEventToResourceType(envelope.kind);
    let projectedWebhookPayload: Record<string, unknown> = envelope.payload;
    if (resourceType && endpoint.peerId) {
      const grantProjection = getFederationGrantProjectionForPeerResource(deps.db, {
        peerId: endpoint.peerId,
        resourceType,
      });
      if (!grantProjection) return c.json({ error: `no grant for shared resource type ${resourceType}` }, 403);
      const projectionOutcome = applySharedEventProjection({
        payload: envelope.payload,
        projection: grantProjection.projection,
        sensitivityCeiling: grantProjection.sensitivityCeiling,
      });
      if (!projectionOutcome.allowed) {
        return c.json({ error: `shared event projection denied: ${projectionOutcome.reason}` }, 403);
      }
      projectedWebhookPayload = projectionOutcome.payload;
    }

    appendFederationEvent(deps.db, {
      id: crypto.randomUUID(),
      peerId: peer.id,
      eventType: envelope.kind,
      direction: "inbound",
      envelopeId: envelope.eventId,
      payload: {
        webhook: projectedWebhookPayload,
        destination: envelope.destination,
      },
      traceId: envelope.traceId,
      nowMs: Date.now(),
    });
    writeFederationAudit({
      peerId: peer.id,
      eventType: "control.webhook_ingress.accepted",
      decision: "info",
      actor: `peer:${peer.id}`,
      traceId: envelope.traceId,
      details: {
        eventId: envelope.eventId,
        endpointId: endpoint.id,
        kind: envelope.kind,
      },
      nowMs: Date.now(),
    });

    return c.json(
      {
        ok: true,
        ackId: crypto.randomUUID(),
        eventId: envelope.eventId,
        receivedAt: Date.now(),
      },
      202,
    );
  });

  // JSON API for live agent graph updates (used by dashboard for smooth refresh)
  app.get("/api/agents", async (c) => {
    const nowMs = Date.now();
    const agentWindowMinutes = clampInt(c.req.query("agentWindowMinutes"), 10, 24 * 60) ?? 360;
    const visibleNodeWindowSeconds = clampInt(c.req.query("visibleNodeWindowSeconds"), 10, 3600) ?? 60;
    const visibleNodeWindowMs = visibleNodeWindowSeconds * 1000;
    const agents = listAgents(deps.agentTracker, nowMs, agentWindowMinutes * 60_000);
    const allowedRunIds = new Set([...agents.active, ...agents.recent].map((r) => r.runId));
    const agentGraph = listAgentGraph(deps.db, allowedRunIds);
    const visibleGraph = filterVisibleAgentGraph(agentGraph, nowMs, visibleNodeWindowMs);
    const mergedAgentRows = [...agents.active, ...agents.recent];
    const visibleAgentRunsById = new Map(filterVisibleAgentRuns(mergedAgentRows, nowMs, visibleNodeWindowMs).map((r) => [r.runId, r]));
    const visibleAgentRuns = [...visibleAgentRunsById.values()];

    const nodes = visibleGraph.map(({ run_id, parent_run_id, agent_id, preset, status, started_at, ended_at, task }) => ({
      run_id,
      parent_run_id,
      agent_id,
      preset,
      status,
      started_at,
      ended_at,
      task,
    }));

    const stats = {
      running: visibleGraph.filter((a) => a.status === "running").length,
      complete: visibleGraph.filter((a) => a.status === "complete").length,
      failed: visibleGraph.filter((a) => a.status === "failed" || a.status === "stopped").length,
      total: visibleGraph.length,
    };

    // Include table data for live updates
    const formatAgentRow = (r: AgentRunInfo) => ({
      status: r.status,
      agentId: r.agentId,
      preset: r.preset,
      channel: `${r.channel}:${r.channelKey}`,
      task: r.task,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      toolCallsUsed: r.toolCallsUsed,
      iterationsUsed: r.iterationsUsed,
    });

    const tables = {
      active: agents.active.map(formatAgentRow),
      recent: visibleAgentRuns.map(formatAgentRow),
    };

    return c.json({ nodes, stats, tables, timestamp: nowMs, visibleNodeWindowSeconds });
  });

  app.get("/api/logs", async (c) => {
    const maxChars = clampInt(c.req.query("maxChars"), 200, 200_000) ?? 50_000;
    const logPath = path.join(deps.stateDir, "gateway.log");
    try {
      const buf = await fs.readFile(logPath);
      const text = buf.toString("utf8");
      return c.text(text.length > maxChars ? text.slice(-maxChars) : text);
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT") {
        return c.text("No logs found.");
      }
      return c.text(`ERROR: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
  });

  app.get("/api/nodes", async (c) => {
    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 200;
    const rows = listNodeRows(deps.db, limit);
    const nodes = rows.map((row) => ({
      id: row.id,
      label: row.label,
      backend: row.backend,
      status: row.status,
      trustLevel: row.trust_level,
      firewallMode: row.firewall_mode,
      endpoint: row.endpoint,
      capabilities: parseStringArrayJson(row.capabilities_json),
      tags: parseStringArrayJson(row.tags_json),
      lastSeenAt: row.last_seen_at,
      connectedAt: row.connected_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    return c.json({ nodes, timestamp: Date.now() });
  });

  app.get("/api/nodes/:id", async (c) => {
    const id = String(c.req.param("id") ?? "").trim();
    if (!id) return c.json({ error: "id is required" }, 400);
    const row = getNodeRowById(deps.db, id);
    if (!row) return c.json({ error: "node not found" }, 404);
    return c.json({
      node: {
        id: row.id,
        label: row.label,
        backend: row.backend,
        status: row.status,
        trustLevel: row.trust_level,
        firewallMode: row.firewall_mode,
        endpoint: row.endpoint,
        capabilities: parseStringArrayJson(row.capabilities_json),
        tags: parseStringArrayJson(row.tags_json),
        lastSeenAt: row.last_seen_at,
        connectedAt: row.connected_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      timestamp: Date.now(),
    });
  });

  app.get("/api/nodes/:id/audit", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    if (!deps.nodeGateway) return c.json({ error: "node gateway is not available" }, 503);

    const id = String(c.req.param("id") ?? "").trim();
    if (!id) return c.json({ error: "id is required" }, 400);
    const row = getNodeRowById(deps.db, id);
    if (!row) return c.json({ error: "node not found" }, 404);
    if (row.backend !== "nexus") {
      return c.json({ error: `node backend ${row.backend} does not support audit.query` }, 400);
    }

    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 100;
    const timeoutMs = clampInt(c.req.query("timeoutMs"), 2_000, 120_000) ?? 15_000;
    const cursorCreatedAt = parseOptionalInt(c.req.query("cursorCreatedAt") ?? c.req.query("cursor"));
    const type = parseOptionalText(c.req.query("type"), 128);
    const processId = parseOptionalText(c.req.query("processId") ?? c.req.query("process"), 128);
    const firewallSession = parseOptionalText(c.req.query("firewallSession"), 256);
    const actor = parseOptionalText(c.req.query("actor"), 256);
    const requestArgs: Record<string, unknown> = {
      id,
      limit,
    };
    if (cursorCreatedAt !== null) requestArgs.cursorCreatedAt = cursorCreatedAt;
    if (type) requestArgs.type = type;
    if (processId) requestArgs.processId = processId;
    if (firewallSession) requestArgs.firewallSession = firewallSession;
    if (actor) requestArgs.actor = actor;

    try {
      const raw = await deps.nodeGateway.executeRoutedCall({
        nodeId: id,
        remoteName: "audit.query",
        args: requestArgs,
        timeoutMs,
        ctx: {
          workspaceDir: "",
          stateDir: deps.stateDir,
          codeDir: "",
          executionNode: id,
          executionMode: "remote",
          nowMs: () => Date.now(),
          log: deps.log,
        },
      });
      const parsed = parseJsonObject(raw);
      return c.json({
        nodeId: id,
        source: "remote",
        timestamp: Date.now(),
        ...(parsed ?? { payload: raw }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = readErrorCode(err);
      const status =
        code === "NODE_SOCKET_UNAVAILABLE" || code === "NODE_OFFLINE"
          ? 503
          : code === "NODE_RESPONSE_TIMEOUT"
            ? 504
            : code === "NODE_PROTOCOL_ERROR"
              ? 400
              : 502;
      return c.json(
        {
          error: message,
          code,
          nodeId: id,
          timestamp: Date.now(),
        },
        status,
      );
    }
  });

  app.get("/api/mcp/overview", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const overview = deps.mcp
      ? deps.mcp.getOverview()
      : {
          servers: listMcpServers(deps.db, { includeDisabled: true }).map((server) => ({
            id: server.id,
            label: server.label,
            enabled: server.enabled,
            active: server.active,
            connected: false,
            trustLevel: server.trustLevel,
            capabilityTags: server.capabilityTags,
            discoveredTools: server.lastDiscoveredTools.length,
            lastError: server.lastError,
            lastErrorAt: server.lastErrorAt,
            lastUsedAt: server.lastUsedAt,
          })),
          profiles: listMcpProfiles(deps.db, { includeDisabled: true }).map((profile) => ({
            id: profile.id,
            name: profile.name,
            serverId: profile.serverId,
            enabled: profile.enabled,
            hidden: profile.hidden,
            ephemeral: profile.ephemeral,
            toolCount: profile.toolNames.length,
            updatedAt: profile.updatedAt,
          })),
        };
    const profileNameById = new Map(overview.profiles.map((profile) => [profile.id, profile.name]));
    const grants = listMcpGrants(deps.db, { includeExpired: false, includeRevoked: false })
      .filter((grant) => grant.status === "active")
      .slice(0, 200)
      .map((grant) => ({
        id: grant.id,
        profileId: grant.profileId,
        profileName: profileNameById.get(grant.profileId) ?? grant.profileId,
        serverId: grant.serverId,
        targetPreset: grant.targetPreset,
        runId: grant.runId,
        parentRunId: grant.parentRunId,
        maxCalls: grant.maxCalls,
        callCount: grant.callCount,
        expiresAt: grant.expiresAt,
        status: grant.status,
        createdAt: grant.createdAt,
        updatedAt: grant.updatedAt,
      }));
    const events = listRecentMcpEvents(deps.db, 100).map((event) => ({
      id: event.id,
      serverId: event.server_id,
      profileId: event.profile_id,
      kind: event.kind,
      payloadJson: event.payload_json,
      createdAt: event.created_at,
    }));
    return c.json({
      available: Boolean(deps.mcp),
      servers: overview.servers,
      profiles: overview.profiles,
      grants,
      events,
      timestamp: Date.now(),
    });
  });

  app.post("/api/nodes/:id/status", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const id = String(c.req.param("id") ?? "").trim();
    if (!id) return c.json({ error: "id is required" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const status = parseNodeStatus(asObject(body).status);
    if (!status) {
      return c.json(
        { error: "status must be one of pending|approved|blocked|offline|online" },
        400,
      );
    }

    const existing = getNodeRecordById(deps.db, id);
    if (!existing) return c.json({ error: "node not found" }, 404);

    const nowMs = Date.now();
    const connectedAt = status === "online" ? existing.connectedAt : null;
    setNodeRecordStatus(deps.db, {
      id,
      status,
      connectedAt,
      nowMs,
    });
    const updated = getNodeRecordById(deps.db, id);
    if (!updated) return c.json({ error: "node not found after update" }, 404);

    return c.json({
      ok: true,
      node: updated,
      timestamp: nowMs,
    });
  });

  app.get("/api/llm/sessions", async (c) => {
    const limit = clampInt(c.req.query("limit"), 1, 200) ?? 50;
    const channel = c.req.query("channel") ?? null;
    const channelKey = c.req.query("channelKey") ?? null;
    const agentId = c.req.query("agentId") ?? null;
    const sessions = listLlmSessions(deps.db, {
      limit,
      channel,
      channelKey,
      agentId,
    });
    return c.json({ sessions, timestamp: Date.now() });
  });

  app.get("/api/llm/messages", async (c) => {
    const sessionId = String(c.req.query("sessionId") ?? "").trim();
    if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 200;
    const beforeIdRaw = String(c.req.query("beforeId") ?? "").trim();
    const beforeId = beforeIdRaw ? Number(beforeIdRaw) : null;
    const before = Number.isFinite(beforeId) && (beforeId ?? 0) > 0 ? Math.floor(beforeId as number) : null;

    const result = listLlmMessages(deps.db, {
      sessionId,
      limit,
      beforeId: before,
    });
    return c.json({
      sessionId,
      messages: result.messages,
      hasMore: result.hasMore,
      nextBeforeId: result.nextBeforeId,
      timestamp: Date.now(),
    });
  });

  app.get("/api/job-runs/export.csv", async (c) => {
    const limit = clampInt(c.req.query("limit"), 1, 10000) ?? 1000;
    const rows = listJobRuns(deps.db, limit);

    const csvHeader = "id,job_id,agent_id,scheduled_for,started_at,ended_at,status,error,tool_calls_used,iterations_used";
    const csvRows = rows.map((r) => {
      const escapeCsv = (s: string | null | undefined) => {
        if (s == null) return "";
        const str = String(s);
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };
      return [
        escapeCsv(r.id),
        escapeCsv(r.job_id),
        escapeCsv(r.agent_id),
        r.scheduled_for ?? "",
        r.started_at ?? "",
        r.ended_at ?? "",
        escapeCsv(r.status),
        escapeCsv(r.error),
        r.tool_calls_used ?? "",
        r.iterations_used ?? "",
      ].join(",");
    });

    const csv = [csvHeader, ...csvRows].join("\n");
    c.header("Content-Type", "text/csv");
    c.header("Content-Disposition", `attachment; filename="job-runs-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body(csv);
  });
}

function listRecentMcpEvents(db: NonNullable<GatewayHttpDeps["db"]>, limit: number): McpEventApiRow[] {
  try {
    return db.db
      .prepare("SELECT id, server_id, profile_id, kind, payload_json, created_at FROM mcp_events ORDER BY created_at DESC LIMIT ?")
      .all(limit) as McpEventApiRow[];
  } catch {
    return [];
  }
}

function parseStringArrayJson(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseOptionalInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed);
}

function parseOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function parseOptionalRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseOptionalText(value: string | undefined, maxChars: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && code.trim().length > 0) return code;
  return "NODE_AUDIT_QUERY_FAILED";
}

function parseFederationPeerTrustState(value: unknown): FederationPeerTrustState | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  switch (normalized) {
    case "pending":
    case "trusted":
    case "revoked":
    case "quarantined":
      return normalized;
    default:
      return null;
  }
}

function parseFederationTaskStatus(value: unknown): FederationTaskStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  switch (normalized) {
    case "pending":
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
      return normalized;
    default:
      return null;
  }
}

function parseFederationOutboxStatus(value: unknown): FederationOutboxStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  switch (normalized) {
    case "pending":
    case "sending":
    case "sent":
    case "acked":
    case "failed":
    case "dead_letter":
      return normalized;
    default:
      return null;
  }
}

function parseFederationSignedEnvelope(value: unknown): FederationSignedEnvelope<Record<string, unknown>> | null {
  const payload = asObject(value);
  const envelopeId = parseUnknownText(payload.envelopeId, 200);
  const schemaVersion = parseUnknownText(payload.schemaVersion, 64);
  const transportKind = parseUnknownText(payload.transportKind, 64);
  const source = parseUnknownText(payload.source, 200);
  const destination = parseUnknownText(payload.destination, 200);
  const methodOrEvent = parseUnknownText(payload.methodOrEvent, 200);
  const nonce = parseUnknownText(payload.nonce, 200);
  const traceId = parseUnknownText(payload.traceId, 200);
  const kid = parseUnknownText(payload.kid, 128);
  const sig = parseUnknownText(payload.sig, 2048);
  const tsRaw = payload.ts;
  const ts = typeof tsRaw === "number" && Number.isFinite(tsRaw) ? Math.floor(tsRaw) : NaN;
  const body = asObject(payload.payload);
  const idempotencyKey = parseUnknownText(payload.idempotencyKey, 256);

  if (
    !envelopeId ||
    !schemaVersion ||
    !transportKind ||
    !source ||
    !destination ||
    !methodOrEvent ||
    !nonce ||
    !traceId ||
    !kid ||
    !sig ||
    !Number.isFinite(ts)
  ) {
    return null;
  }
  if (transportKind !== "federation_http") return null;

  return {
    envelopeId,
    schemaVersion,
    transportKind,
    source,
    destination,
    methodOrEvent,
    ts,
    nonce,
    payload: body,
    idempotencyKey: idempotencyKey ?? undefined,
    traceId,
    kid,
    sig,
  };
}

function applyInboxTaskMutation(
  db: NonNullable<GatewayHttpDeps["db"]>,
  peerId: string,
  envelope: FederationSignedEnvelope<Record<string, unknown>>,
  nowMs: number,
): { taskId: string | null; duplicateTask: boolean; taskUpdated: boolean } {
  const method = envelope.methodOrEvent.trim().toLowerCase();
  const payload = envelope.payload ?? {};

  if (method === "submit_task" || method === "task.submit") {
    const taskId =
      parseUnknownText(payload.taskId, 256) ??
      parseUnknownText(envelope.idempotencyKey, 256) ??
      parseUnknownText(envelope.traceId, 256) ??
      envelope.envelopeId;
    const existingTask = getFederationTaskById(db, taskId);
    if (existingTask) {
      return { taskId, duplicateTask: true, taskUpdated: false };
    }
    const requestPayload = parseOptionalRecord(payload.request) ?? payload;
    const declaredMethod = parseUnknownText(payload.method, 128) ?? envelope.methodOrEvent;
    createFederationTask(db, {
      id: taskId,
      peerId,
      method: declaredMethod,
      request: requestPayload,
      idempotencyKey: parseUnknownText(envelope.idempotencyKey, 256),
      nowMs,
    });
    return { taskId, duplicateTask: false, taskUpdated: false };
  }

  if (method === "task_status" || method === "task.status") {
    const taskId = parseUnknownText(payload.taskId, 256);
    if (!taskId) {
      return { taskId: null, duplicateTask: false, taskUpdated: false };
    }
    const status = parseFederationTaskStatus(payload.status);
    if (!status) {
      return { taskId, duplicateTask: false, taskUpdated: false };
    }
    const updated = updateFederationTask(db, {
      id: taskId,
      status,
      result: parseOptionalRecord(payload.result),
      error: parseOptionalRecord(payload.error),
      nowMs,
    });
    return { taskId, duplicateTask: false, taskUpdated: updated };
  }

  return { taskId: null, duplicateTask: false, taskUpdated: false };
}

function parseUnknownText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function parseEnvByteLimit(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const bounded = Math.floor(parsed);
  if (bounded < 1_024) return 1_024;
  if (bounded > 20 * 1024 * 1024) return 20 * 1024 * 1024;
  return bounded;
}

async function readRequestBodyTextLimited(
  c: Context,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; status: 413; error: string }> {
  const contentLengthHeader = c.req.header("content-length");
  if (contentLengthHeader) {
    const declaredBytes = Number(contentLengthHeader);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      return {
        ok: false,
        status: 413,
        error: `request body exceeds max size (${maxBytes} bytes)`,
      };
    }
  }
  const stream = c.req.raw.body;
  if (!stream) return { ok: true, text: "" };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        return {
          ok: false,
          status: 413,
          error: `request body exceeds max size (${maxBytes} bytes)`,
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 0) return { ok: true, text: "" };
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return {
    ok: true,
    text: buffer.toString("utf8"),
  };
}

async function readJsonBodyLimited(
  c: Context,
  maxBytes: number,
): Promise<{ ok: true; text: string; value: unknown } | { ok: false; status: 400 | 413; error: string }> {
  const body = await readRequestBodyTextLimited(c, maxBytes);
  if (!body.ok) return body;
  try {
    return {
      ok: true,
      text: body.text,
      value: JSON.parse(body.text) as unknown,
    };
  } catch {
    return {
      ok: false,
      status: 400,
      error: "invalid JSON body",
    };
  }
}

function parseBooleanQuery(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return defaultValue;
}

function parseFederationEventDirection(value: unknown): "inbound" | "outbound" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized === "inbound" || normalized === "outbound") return normalized;
  return null;
}

function parseFederationExportResourceType(value: unknown): FederationExportResourceType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  switch (normalized) {
    case "node_pool":
    case "data_intake":
    case "blackboard":
    case "mcp":
      return normalized;
    default:
      return null;
  }
}

function parseWebhookEndpointOwnerScope(value: unknown): WebhookEndpointOwnerScope | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized === "local" || normalized === "federation_peer") return normalized;
  return null;
}

function parseWebhookEndpointSigningMode(value: unknown): WebhookEndpointSigningMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized === "hmac" || normalized === "ed25519") return normalized;
  return null;
}

function parseWebhookEndpointStatus(value: unknown): WebhookEndpointStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized === "active" || normalized === "paused" || normalized === "revoked") return normalized;
  return null;
}

function parseWebhookDeliveryStatus(value: unknown): WebhookDeliveryStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  switch (normalized) {
    case "pending":
    case "sending":
    case "acked":
    case "failed":
    case "dead_letter":
      return normalized;
    default:
      return null;
  }
}

function parseWebhookEventFilter(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .slice(0, 200);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .slice(0, 200);
  }
  return [];
}

function parseFederationWebhookEnvelope(value: unknown): FederationWebhookEnvelope<Record<string, unknown>> | null {
  const payload = asObject(value);
  const schemaVersion = parseUnknownText(payload.schemaVersion, 32);
  const eventId = parseUnknownText(payload.eventId, 200);
  const traceId = parseUnknownText(payload.traceId, 200);
  const kind = parseUnknownText(payload.kind, 200);
  const sourceInstance = parseUnknownText(payload.sourceInstance, 200);
  const tsRaw = payload.ts;
  const ts = typeof tsRaw === "number" && Number.isFinite(tsRaw) ? Math.floor(tsRaw) : NaN;
  const nonce = parseUnknownText(payload.nonce, 200);
  const idempotencyKey = parseUnknownText(payload.idempotencyKey, 256);
  const sensitivity = parseUnknownText(payload.sensitivity, 64);
  const destinationRaw = asObject(payload.destination);
  const destinationEndpointId = parseUnknownText(destinationRaw.endpointId, 200);
  const destinationPeerId = parseUnknownText(destinationRaw.peerId, 200);
  const bodyPayload = parseOptionalRecord(payload.payload) ?? {};
  const metaRaw = asObject(payload.meta);
  const attempt = typeof metaRaw.attempt === "number" && Number.isFinite(metaRaw.attempt) ? Math.max(1, Math.floor(metaRaw.attempt)) : 1;
  const maxAttempts = typeof metaRaw.maxAttempts === "number" && Number.isFinite(metaRaw.maxAttempts)
    ? Math.max(1, Math.floor(metaRaw.maxAttempts))
    : 12;
  const orderingKey = parseUnknownText(metaRaw.orderingKey, 256) ?? `event:${eventId ?? "unknown"}`;

  if (
    schemaVersion !== "1.0" ||
    !eventId ||
    !traceId ||
    !kind ||
    !sourceInstance ||
    !Number.isFinite(ts) ||
    !nonce ||
    !idempotencyKey ||
    !sensitivity ||
    !destinationEndpointId
  ) {
    return null;
  }

  return {
    schemaVersion: "1.0",
    eventId,
    traceId,
    kind,
    sourceInstance,
    destination: {
      endpointId: destinationEndpointId,
      peerId: destinationPeerId ?? undefined,
    },
    ts,
    nonce,
    idempotencyKey,
    sensitivity,
    payload: bodyPayload,
    meta: {
      attempt,
      maxAttempts,
      orderingKey,
    },
  };
}

function mapSharedEventToResourceType(eventType: string): FederationExportResourceType | null {
  const normalized = eventType.trim().toLowerCase();
  if (normalized.startsWith("node.share.")) return "node_pool";
  if (normalized.startsWith("data_intake.share.")) return "data_intake";
  if (normalized.startsWith("blackboard.share.")) return "blackboard";
  if (normalized.startsWith("mcp.share.")) return "mcp";
  return null;
}

function isUnsafeWebhookHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "metadata.google.internal" || normalized === "metadata.google.internal.") return true;
  if (normalized === "metadata.azure.internal" || normalized === "metadata") return true;
  const kind = net.isIP(normalized);
  if (kind === 0) return false;
  if (kind === 4) {
    const octets = normalized.split(".").map((part) => Number(part));
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 0) return true;
    return false;
  }
  if (normalized === "::1") return true;
  if (normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  return false;
}

function parseNodeStatus(value: unknown): "pending" | "approved" | "blocked" | "offline" | "online" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  switch (normalized) {
    case "pending":
      return "pending";
    case "approved":
      return "approved";
    case "blocked":
      return "blocked";
    case "offline":
      return "offline";
    case "online":
      return "online";
    default:
      return null;
  }
}
