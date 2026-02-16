#!/usr/bin/env tsx
import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import process from "node:process";
import type { AddressInfo } from "node:net";

import { WebSocket, WebSocketServer } from "ws";

const ED25519_SPKI_RAW_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

type RequestEnvelope = {
  type: "req";
  id: string;
  ts: number;
  sender: string;
  sig: string;
  method: string;
  params?: unknown;
};

type ResponseEnvelope = {
  type: "res";
  id: string | null;
  ts: number;
  sender: string;
  sig: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
  };
};

type EventEnvelope = {
  type: "event";
  ts: number;
  sender: string;
  sig: string;
  event: string;
  payload?: unknown;
};

type Envelope = RequestEnvelope | ResponseEnvelope | EventEnvelope;

type ParsedPublicKey = {
  key: KeyObject;
  raw: string;
  fingerprint: string;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function timeoutPromise<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(params: {
  timeoutMs: number;
  intervalMs: number;
  message: string;
  predicate: () => boolean;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    if (params.predicate()) return;
    await sleep(params.intervalMs);
  }
  throw new Error(params.message);
}

async function main(): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-node-smoke-"));
  const symbolsStoreDir = path.join(stateDir, "hermes-stores");
  await fs.mkdir(symbolsStoreDir, { recursive: true });
  await fs.writeFile(
    path.join(symbolsStoreDir, "contacts.json"),
    JSON.stringify(
      [
        {
          key: "sarah",
          email: "sarah-smoke@example.com",
          phone: "+1-555-0001",
          firstName: "Sarah",
        },
      ],
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(symbolsStoreDir, "accounts.json"),
    JSON.stringify(
      {
        "aws-prod": {
          accessKeyId: "AKIA-SMOKE-KEY",
          region: "us-east-1",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(symbolsStoreDir, "secrets.json"),
    JSON.stringify(
      {
        "slack-bot": {
          token: "xoxb-smoke-secret-token",
        },
        "db-password": "supersecret-smoke-password",
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(symbolsStoreDir, "user.json"),
    JSON.stringify(
      {
        timezone: "UTC",
        displayName: "Smoke User",
      },
      null,
      2,
    ),
    "utf8",
  );
  const policyPresetDir = path.join(stateDir, "policy-presets");
  await fs.mkdir(policyPresetDir, { recursive: true });
  await fs.writeFile(
    path.join(policyPresetDir, "smoke-soft.json"),
    JSON.stringify(
      {
        version: 1,
        defaultQuarantine: "soft",
        firewallMode: "audit-only",
        label: "smoke-soft",
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(policyPresetDir, "smoke-hard.json"),
    JSON.stringify(
      {
        version: 2,
        defaultQuarantine: "hard",
        label: "smoke-hard",
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(policyPresetDir, "smoke-hermes-deny-uname.json"),
    JSON.stringify(
      {
        version: 3,
        firewallMode: "hermes",
        denyCommands: ["uname"],
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(policyPresetDir, "smoke-hermes-clear-deny.json"),
    JSON.stringify(
      {
        version: 4,
        firewallMode: "hermes",
        denyCommands: [],
      },
      null,
      2,
    ),
    "utf8",
  );
  const nodeId = `smoke-node-${randomUUID().slice(0, 8)}`;
  const gatewayKeys = generateKeyPairSync("ed25519");
  const gatewayPubRaw = publicKeyRaw(gatewayKeys.publicKey);
  assert.ok(gatewayPubRaw, "failed to derive gateway public key");
  const gatewayPublicKeyRaw = toBase64Url(gatewayPubRaw);
  const gatewayFingerprint = createHash("sha256").update(gatewayPubRaw).digest("hex");

  let child: ChildProcessWithoutNullStreams | null = null;
  const childStdout: string[] = [];
  const childStderr: string[] = [];
  const pendingResponses = new Map<string, Deferred<ResponseEnvelope>>();
  const initialReady = deferred<void>();
  const initialHandshakeComplete = deferred<void>();
  const reconnectReady = deferred<void>();
  const reconnectHandshakeComplete = deferred<void>();
  const nodePublicKeyDeferred = deferred<ParsedPublicKey>();
  const invalidGatewayProofRejected = deferred<void>();
  const invalidNodeProofRejected = deferred<void>();

  let wsRef: WebSocket | null = null;
  let nodePublic: ParsedPublicKey | null = null;
  let nodeSender: string | null = null;
  let handshakeAttempt = 0;
  let handshakeCount = 0;
  let capsAdvertiseCount = 0;
  let invalidGatewayProofSeen = false;
  let invalidNodeProofSeen = false;
  let suppressNextTerminalAck = false;
  let withheldDeliveryId: string | null = null;
  let replayedWithheldDelivery = false;
  const logAppendChunksByProcess = new Map<string, string[]>();
  const sessionStateBySocket = new WeakMap<
    WebSocket,
    {
      sessionId: string;
      nodeNonce: string;
      gatewayNonce: string;
      nodeId: string;
      expectInvalidNodeProof: boolean;
    }
  >();

  const wss = new WebSocketServer({ port: 0 });
  try {
    await timeoutPromise(
      new Promise<void>((resolve) => wss.once("listening", () => resolve())),
      5_000,
      "mock gateway did not start listening in time",
    );
    const addr = wss.address() as AddressInfo;
    const gatewayUrl = `ws://127.0.0.1:${addr.port}/nx/nodes`;

    const tsxBin = path.join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx",
    );
    const tlsPolicyStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-node-smoke-tls-policy-"));
    const tlsPolicyStderr: string[] = [];
    const tlsPolicyChild = spawn(
      tsxBin,
      [
        "examples/nexus-node/reference-node.ts",
        "--gateway",
        "ws://203.0.113.10:18789/nx/nodes",
        "--node-id",
        `tls-policy-${randomUUID().slice(0, 8)}`,
        "--state-dir",
        tlsPolicyStateDir,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    tlsPolicyChild.stderr.on("data", (chunk) => {
      tlsPolicyStderr.push(String(chunk));
    });
    try {
      const tlsPolicyExit = await timeoutPromise(
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          tlsPolicyChild.once("exit", (code, signal) => {
            resolve({ code, signal });
          });
        }),
        8_000,
        "tls policy preflight child did not exit",
      );
      assert.notEqual(tlsPolicyExit.code, 0, "expected non-loopback ws:// gateway policy check to fail");
      assert.match(
        tlsPolicyStderr.join(""),
        /TLS is required for non-loopback gateway endpoints/,
        "expected non-loopback ws:// policy failure message",
      );
    } finally {
      if (tlsPolicyChild.exitCode === null && !tlsPolicyChild.killed) {
        try {
          tlsPolicyChild.kill("SIGKILL");
        } catch {
          // ignore cleanup failures in smoke preflight.
        }
      }
      await fs.rm(tlsPolicyStateDir, { recursive: true, force: true });
    }

    const spawnedChild = spawn(
      tsxBin,
      [
        "examples/nexus-node/reference-node.ts",
        "--gateway",
        gatewayUrl,
        "--node-id",
        nodeId,
        "--state-dir",
        stateDir,
        "--allow",
        "echo,uname,whoami,pwd,date,ls,sleep,nexus-policyctl",
        "--reconnect-min-ms",
        "500",
        "--reconnect-max-ms",
        "1500",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child = spawnedChild;

    spawnedChild.stdout.on("data", (chunk) => {
      childStdout.push(String(chunk));
    });
    spawnedChild.stderr.on("data", (chunk) => {
      childStderr.push(String(chunk));
    });

    wss.on("connection", (ws) => {
      wsRef = ws;
      ws.on("close", (code, reasonRaw) => {
        if (wsRef === ws) wsRef = null;
        const reason = String(reasonRaw || "");
        if (!invalidGatewayProofSeen && code === 4001 && reason.includes("invalid gateway proof")) {
          invalidGatewayProofSeen = true;
          invalidGatewayProofRejected.resolve();
        }
        if (!invalidNodeProofSeen && code === 4001 && reason.includes("invalid node proof")) {
          invalidNodeProofSeen = true;
          invalidNodeProofRejected.resolve();
        }
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const raw = typeof data === "string" ? data : data.toString("utf8");
        try {
          const envelopeObj = asObject(JSON.parse(raw));
          const msg = parseEnvelope(envelopeObj);
          if (!msg) return;

          if (msg.type === "req" && msg.method === "connect.hello") {
            const params = asObject(msg.params);
            const sender = msg.sender;
            const helloNodeId = asString(params.nodeId);
            assert.equal(sender, `node:${helloNodeId}`);
            const device = asObject(params.device);
            const publicKeyRaw = asString(device.publicKey);
            const parsedPublic = publicKeyRaw ? parsePublicKey(publicKeyRaw) : null;
            assert.ok(parsedPublic, "connect.hello missing/invalid public key");
            assert.equal(asString(device.fingerprint), parsedPublic.fingerprint);
            assert.ok(verifyEnvelopeSignature(envelopeObj, parsedPublic.key), "connect.hello signature invalid");

            if (!nodePublic) {
              nodePublic = parsedPublic;
              nodePublicKeyDeferred.resolve(parsedPublic);
            } else {
              assert.equal(parsedPublic.fingerprint, nodePublic.fingerprint, "node fingerprint changed after reconnect");
            }
            if (!nodeSender) {
              nodeSender = msg.sender;
            } else {
              assert.equal(msg.sender, nodeSender, "node sender changed after reconnect");
            }
            const nodeNonce = asString(params.nodeNonce);
            assert.ok(nodeNonce, "connect.hello missing nodeNonce");
            handshakeAttempt += 1;
            const expectInvalidGatewayProof = handshakeAttempt === 1;
            const expectInvalidNodeProof = handshakeAttempt === 2;
            const sessionId = `sess-${randomUUID().slice(0, 12)}`;
            const gatewayNonce = randomBytes(32).toString("base64url");
            sessionStateBySocket.set(ws, {
              sessionId,
              nodeNonce: expectInvalidNodeProof ? `${nodeNonce}-tampered` : nodeNonce!,
              gatewayNonce,
              nodeId: helloNodeId ?? nodeId,
              expectInvalidNodeProof,
            });

            const transcript = buildHandshakeTranscript({
              nodeId: helloNodeId ?? nodeId,
              sessionId,
              nodeNonce: nodeNonce!,
              gatewayNonce,
            });
            const gatewayProofSig = signDetachedPayload(
              expectInvalidGatewayProof ? { ...transcript, nodeNonce: `${nodeNonce}-tampered` } : transcript,
              gatewayKeys.privateKey,
            );

            sendSignedEnvelope(ws, gatewayKeys.privateKey, "gateway:smoke", {
              type: "event",
              event: "connect.challenge",
              payload: {
                sessionId,
                gatewayNonce,
                gatewayPublicKey: gatewayPublicKeyRaw,
                gatewayFingerprint,
                gatewayProofSig,
              },
            });

            // Optional acknowledgment response for connect.hello.
            sendSignedEnvelope(ws, gatewayKeys.privateKey, "gateway:smoke", {
              type: "res",
              id: msg.id,
              ok: true,
              payload: {
                sessionId,
                status: "connected",
                challengeIssued: true,
              },
            });
            return;
          }

          if (msg.type === "req" && msg.method === "connect.prove") {
            assert.ok(nodePublic, "node public key should be established before connect.prove");
            assert.equal(msg.sender, nodeSender);
            assert.ok(verifyEnvelopeSignature(envelopeObj, nodePublic!.key), "connect.prove envelope signature invalid");
            const params = asObject(msg.params);
            const nodeProofSig = asString(params.nodeProofSig);
            assert.ok(nodeProofSig, "connect.prove missing nodeProofSig");
            const state = sessionStateBySocket.get(ws);
            assert.ok(state, "missing handshake state for websocket session");

            const transcript = buildHandshakeTranscript({
              nodeId: state!.nodeId,
              sessionId: state!.sessionId,
              nodeNonce: state!.nodeNonce,
              gatewayNonce: state!.gatewayNonce,
            });
            const nodeProofValid = verifyDetachedPayload(transcript, nodeProofSig!, nodePublic!.key);
            if (!nodeProofValid) {
              if (state!.expectInvalidNodeProof && !invalidNodeProofSeen) {
                invalidNodeProofSeen = true;
                invalidNodeProofRejected.resolve();
                ws.close(4001, "invalid node proof");
                return;
              }
              assert.fail("node proof signature invalid");
            }
            if (state!.expectInvalidNodeProof) {
              assert.fail("expected invalid node proof scenario but node proof verified");
            }

            sendSignedEnvelope(ws, gatewayKeys.privateKey, "gateway:smoke", {
              type: "event",
              event: "connect.accept",
              payload: {
                sessionId: state!.sessionId,
                connectedAt: Date.now(),
                gatewayFingerprint,
                gatewayAcceptSig: signDetachedPayload(transcript, gatewayKeys.privateKey),
              },
            });
            sendSignedEnvelope(ws, gatewayKeys.privateKey, "gateway:smoke", {
              type: "res",
              id: msg.id,
              ok: true,
              payload: {
                sessionId: state!.sessionId,
                status: "ready",
              },
            });
            handshakeCount += 1;
            if (handshakeCount === 1) initialHandshakeComplete.resolve();
            if (handshakeCount === 2) reconnectHandshakeComplete.resolve();
            return;
          }

          if (!nodePublic) return;
          assert.equal(msg.sender, nodeSender);
          assert.ok(verifyEnvelopeSignature(envelopeObj, nodePublic.key), `invalid signed envelope for ${msg.type}`);

          if (msg.type === "event") {
            if (msg.event === "caps.advertise") {
              capsAdvertiseCount += 1;
              if (capsAdvertiseCount === 1) initialReady.resolve();
              if (capsAdvertiseCount === 2) reconnectReady.resolve();
              return;
            }
            if (msg.event === "log.append") {
              const payload = asObject(msg.payload);
              const processId = asString(payload.processId);
              const chunk = payload.chunk;
              if (processId && typeof chunk === "string" && chunk.length > 0) {
                const chunks = logAppendChunksByProcess.get(processId) ?? [];
                chunks.push(chunk);
                logAppendChunksByProcess.set(processId, chunks);
              }
              return;
            }
            if (msg.event === "process.update") {
              const payload = asObject(msg.payload);
              const deliveryId = asString(payload.deliveryId);
              const processId = asString(payload.processId);
              if (deliveryId) {
                const shouldSuppress = suppressNextTerminalAck && handshakeCount === 1 && !withheldDeliveryId;
                if (shouldSuppress) {
                  suppressNextTerminalAck = false;
                  withheldDeliveryId = deliveryId;
                } else {
                  if (withheldDeliveryId && deliveryId === withheldDeliveryId && handshakeCount >= 2) {
                    replayedWithheldDelivery = true;
                  }
                  sendSignedEnvelope(ws, gatewayKeys.privateKey, "gateway:smoke", {
                    type: "req",
                    id: randomUUID(),
                    method: "process.ack",
                    params: {
                      deliveryId,
                      processId,
                    },
                  });
                }
              }
              return;
            }
          }

          if (msg.type === "res" && msg.id) {
            const pending = pendingResponses.get(msg.id);
            if (!pending) return;
            pendingResponses.delete(msg.id);
            pending.resolve(msg);
          }
        } catch (err) {
          const wrapped = err instanceof Error ? err : new Error(String(err));
          for (const pending of pendingResponses.values()) pending.reject(wrapped);
          pendingResponses.clear();
          initialReady.reject(wrapped);
          reconnectReady.reject(wrapped);
          initialHandshakeComplete.reject(wrapped);
          reconnectHandshakeComplete.reject(wrapped);
          nodePublicKeyDeferred.reject(wrapped);
          invalidGatewayProofRejected.reject(wrapped);
          invalidNodeProofRejected.reject(wrapped);
        }
      });
    });

    await timeoutPromise(
      invalidGatewayProofRejected.promise,
      12_000,
      "node did not reject invalid connect.challenge gateway proof signature",
    );
    await timeoutPromise(
      invalidNodeProofRejected.promise,
      12_000,
      "gateway did not reject invalid connect.prove node proof signature",
    );
    await timeoutPromise(initialHandshakeComplete.promise, 12_000, "initial handshake did not complete");
    await timeoutPromise(initialReady.promise, 12_000, "node did not advertise capabilities on initial connect");
    const parsedNodePublic = await timeoutPromise(nodePublicKeyDeferred.promise, 2_000, "node public key missing");
    assert.ok(wsRef, "websocket connection missing");

    const whichRes = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.which",
        args: {
          command: "echo",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(whichRes.ok, true, `system.which failed: ${asString(asObject(whichRes.error).message) ?? "unknown"}`);
    const whichOutput = asString(asObject(whichRes.payload).output);
    assert.ok(whichOutput && whichOutput.length > 0, "system.which returned empty output");

    const runRes = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "echo smoke-ok",
        },
      },
      timeoutMs: 15_000,
    });
    assert.equal(runRes.ok, true, `system.run failed: ${asString(asObject(runRes.error).message) ?? "unknown"}`);
    const runOutput = asString(asObject(runRes.payload).output) ?? "";
    assert.match(runOutput, /smoke-ok/);

    const symbolsListRes = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "symbols.list",
      params: {
        includeFields: true,
      },
      timeoutMs: 10_000,
    });
    assert.equal(symbolsListRes.ok, true, "symbols.list failed");
    const symbolsPayload = asObject(symbolsListRes.payload);
    const catalogObj = asObject(symbolsPayload.catalog);
    const contactsCatalog = (catalogObj.contact as Array<Record<string, unknown>> | undefined) ?? [];
    const accountsCatalog = (catalogObj.account as Array<Record<string, unknown>> | undefined) ?? [];
    const secretsCatalog = (catalogObj.secret as Array<Record<string, unknown>> | undefined) ?? [];
    const userCatalog = (catalogObj.user as Array<Record<string, unknown>> | undefined) ?? [];
    assert.ok(contactsCatalog.some((entry) => asString(entry.key) === "sarah"), "symbols.list missing contact key");
    assert.ok(accountsCatalog.some((entry) => asString(entry.key) === "aws-prod"), "symbols.list missing account key");
    assert.ok(secretsCatalog.some((entry) => asString(entry.key) === "slack-bot"), "symbols.list missing secret key");
    assert.ok(userCatalog.some((entry) => asString(entry.key) === "timezone"), "symbols.list missing user field key");
    const symbolStrings = (symbolsPayload.symbols as string[] | undefined) ?? [];
    assert.ok(
      symbolStrings.includes("{{contact:sarah}}") && symbolStrings.includes("{{contact:sarah:email}}"),
      "symbols.list missing contact symbol forms",
    );
    assert.ok(
      symbolStrings.includes("{{secret:slack-bot:token}}"),
      "symbols.list missing secret field symbol form",
    );
    const symbolsPayloadJson = JSON.stringify(symbolsPayload);
    assert.ok(
      !symbolsPayloadJson.includes("sarah-smoke@example.com") &&
        !symbolsPayloadJson.includes("xoxb-smoke-secret-token") &&
        !symbolsPayloadJson.includes("supersecret-smoke-password"),
      "symbols.list must not expose raw secure store values",
    );

    const symbolsSecretOnlyRes = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "symbols.list",
      params: {
        kind: "secret",
        includeFields: false,
      },
      timeoutMs: 10_000,
    });
    assert.equal(symbolsSecretOnlyRes.ok, true, "symbols.list kind=secret failed");
    const symbolsSecretOnlyPayload = asObject(symbolsSecretOnlyRes.payload);
    assert.equal(asString(symbolsSecretOnlyPayload.kind), "secret");
    const secretOnlyCatalog = asObject(symbolsSecretOnlyPayload.catalog);
    assert.equal(
      ((secretOnlyCatalog.secret as Array<unknown> | undefined) ?? []).length > 0,
      true,
      "symbols.list kind=secret should include secret entries",
    );
    assert.equal(
      ((secretOnlyCatalog.contact as Array<unknown> | undefined) ?? []).length,
      0,
      "symbols.list kind=secret should not include contact entries",
    );

    const symbolRunRes = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "echo {{secret:slack-bot:token}}",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(symbolRunRes.ok, true, "system.run should execute in transparent mode");
    const symbolRunOutput = asString(asObject(symbolRunRes.payload).output) ?? "";
    assert.match(
      symbolRunOutput,
      /\{\{secret:slack-bot:token\}\}/,
      "transparent mode should keep symbol placeholders unresolved",
    );
    assert.ok(
      !symbolRunOutput.includes("xoxb-smoke-secret-token"),
      "transparent mode should not resolve secret symbols",
    );

    const symbolRunMissing = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "echo {{secret:missing-secret:token}}",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(symbolRunMissing.ok, true, "transparent mode should not fail on unresolved symbols");
    assert.match(
      asString(asObject(symbolRunMissing.payload).output) ?? "",
      /\{\{secret:missing-secret:token\}\}/,
      "transparent mode should pass unresolved missing symbol placeholders",
    );

    const deniedRes = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "rm -rf /tmp/nexus-smoke",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(deniedRes.ok, false, "expected disallowed command to fail");
    assert.equal(asString(asObject(deniedRes.error).code), "PERMISSION_DENIED");
    assert.match(
      asString(asObject(deniedRes.error).message) ?? "",
      /allowlisted/i,
      "deny reason should reference allowlist constraints",
    );

    const chainedRunDenied = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "echo bypass-check && uname -a",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(chainedRunDenied.ok, false, "expected chained system.run command to be denied");
    assert.equal(asString(asObject(chainedRunDenied.error).code), "PERMISSION_DENIED");
    assert.match(
      asString(asObject(chainedRunDenied.error).message) ?? "",
      /single allowlisted command/i,
      "expected shell operator denial reason",
    );

    const chainedStartDenied = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.start",
      params: {
        tool: "system.run",
        args: {
          command: "echo bypass-check && uname -a",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(chainedStartDenied.ok, false, "expected chained process.start command to be denied");
    assert.equal(asString(asObject(chainedStartDenied.error).code), "PERMISSION_DENIED");
    assert.match(
      asString(asObject(chainedStartDenied.error).message) ?? "",
      /single allowlisted command/i,
      "expected process.start shell operator denial reason",
    );

    const shortProcStart = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.start",
      params: {
        tool: "system.run",
        args: {
          command: "echo proc-smoke",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(shortProcStart.ok, true, "process.start short command failed");
    const shortProcessId = asString(asObject(shortProcStart.payload).processId);
    assert.ok(shortProcessId, "process.start did not return processId");
    assert.equal(
      asString(asObject(shortProcStart.payload).firewallSession),
      null,
      "transparent mode process.start should not create firewall sessions",
    );

    let shortStatus = "";
    for (let i = 0; i < 20; i += 1) {
      const statusRes = await sendGatewayRequest({
        ws: wsRef!,
        gatewayPrivateKey: gatewayKeys.privateKey,
        gatewaySender: "gateway:smoke",
        pendingResponses,
        nodePublicKey: parsedNodePublic.key,
        method: "process.status",
        params: {
          processId: shortProcessId,
        },
        timeoutMs: 10_000,
      });
      assert.equal(statusRes.ok, true, "process.status for short process failed");
      shortStatus = asString(asObject(statusRes.payload).status) ?? "";
      if (shortStatus === "completed" || shortStatus === "failed" || shortStatus === "cancelled") break;
      await sleep(100);
    }
    assert.equal(shortStatus, "completed", `expected short process to complete, got ${shortStatus}`);

    const shortLogs = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.logs",
      params: {
        processId: shortProcessId,
        maxChars: 4000,
      },
      timeoutMs: 10_000,
    });
    assert.equal(shortLogs.ok, true, "process.logs for short process failed");
    const shortLogText = asString(asObject(shortLogs.payload).logs) ?? "";
    assert.match(shortLogText, /proc-smoke/, "short process logs missing output");

    const symbolProcStart = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.start",
      params: {
        tool: "system.run",
        args: {
          command: "echo {{user:displayName}}",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(symbolProcStart.ok, true, "process.start symbol resolution failed");
    const symbolProcessId = asString(asObject(symbolProcStart.payload).processId);
    assert.ok(symbolProcessId, "symbol process missing processId");

    let symbolProcStatus = "";
    for (let i = 0; i < 20; i += 1) {
      const statusRes = await sendGatewayRequest({
        ws: wsRef!,
        gatewayPrivateKey: gatewayKeys.privateKey,
        gatewaySender: "gateway:smoke",
        pendingResponses,
        nodePublicKey: parsedNodePublic.key,
        method: "process.status",
        params: {
          processId: symbolProcessId,
        },
        timeoutMs: 10_000,
      });
      assert.equal(statusRes.ok, true, "process.status for symbol process failed");
      symbolProcStatus = asString(asObject(statusRes.payload).status) ?? "";
      if (symbolProcStatus === "completed" || symbolProcStatus === "failed" || symbolProcStatus === "cancelled") break;
      await sleep(100);
    }
    assert.equal(symbolProcStatus, "completed", `expected symbol process to complete, got ${symbolProcStatus}`);
    const symbolProcLogs = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.logs",
      params: {
        processId: symbolProcessId,
        maxChars: 4000,
      },
      timeoutMs: 10_000,
    });
    assert.equal(symbolProcLogs.ok, true, "process.logs for symbol process failed");
    assert.match(
      asString(asObject(symbolProcLogs.payload).logs) ?? "",
      /\{\{user:displayName\}\}/,
      "transparent mode process logs should preserve unresolved symbol placeholders",
    );

    const auditSymbolsRes = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "audit.query",
      params: {
        type: "symbols.list",
        limit: 20,
      },
      timeoutMs: 10_000,
    });
    assert.equal(auditSymbolsRes.ok, true, "audit.query symbols filter failed");
    const auditSymbolsPayload = asObject(auditSymbolsRes.payload);
    const auditSymbolsEvents = (Array.isArray(auditSymbolsPayload.events) ? auditSymbolsPayload.events : []) as Array<
      Record<string, unknown>
    >;
    assert.ok(auditSymbolsEvents.length > 0, "audit.query should return symbols.list events");
    assert.ok(
      auditSymbolsEvents.every((event) => asString(asObject(event).type) === "symbols.list"),
      "audit.query type filter should only return symbols.list events",
    );

    const auditProcessRes = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "audit.query",
      params: {
        processId: shortProcessId,
        limit: 50,
      },
      timeoutMs: 10_000,
    });
    assert.equal(auditProcessRes.ok, true, "audit.query processId filter failed");
    const auditProcessPayload = asObject(auditProcessRes.payload);
    const auditProcessEvents = (Array.isArray(auditProcessPayload.events) ? auditProcessPayload.events : []) as Array<
      Record<string, unknown>
    >;
    assert.ok(
      auditProcessEvents.some(
        (event) =>
          asString(asObject(event).type) === "process.start.requested" &&
          asString(asObject(event).processId) === shortProcessId,
      ),
      "audit.query should include process.start.requested for filtered process",
    );

    const auditPageOne = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "audit.query",
      params: {
        limit: 1,
      },
      timeoutMs: 10_000,
    });
    assert.equal(auditPageOne.ok, true, "audit.query page 1 failed");
    const auditPageOnePayload = asObject(auditPageOne.payload);
    const nextCursor = asNumber(auditPageOnePayload.nextCursorCreatedAt);
    if (nextCursor !== null) {
      const auditPageTwo = await sendGatewayRequest({
        ws: wsRef!,
        gatewayPrivateKey: gatewayKeys.privateKey,
        gatewaySender: "gateway:smoke",
        pendingResponses,
        nodePublicKey: parsedNodePublic.key,
        method: "audit.query",
        params: {
          limit: 5,
          cursorCreatedAt: nextCursor,
        },
        timeoutMs: 10_000,
      });
      assert.equal(auditPageTwo.ok, true, "audit.query page 2 failed");
    }

    const legacyPolicyUpdate = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "policy.update",
      params: {
        policy: {
          firewallMode: "audit-only",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(legacyPolicyUpdate.ok, false, "legacy policy.update should no longer be supported");
    assert.equal(asString(asObject(legacyPolicyUpdate.error).code), "METHOD_NOT_IMPLEMENTED");

    const unallowlistedPolicyCommand = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "nexus-policyctlx show",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(unallowlistedPolicyCommand.ok, false, "non-allowlisted policy command should be denied");
    assert.equal(asString(asObject(unallowlistedPolicyCommand.error).code), "PERMISSION_DENIED");

    const policyShowProcessStart = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.start",
      params: {
        tool: "system.run",
        args: {
          command: "nexus-policyctl show",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(policyShowProcessStart.ok, true, "process.start nexus-policyctl show failed");
    const policyShowProcessId = asString(asObject(policyShowProcessStart.payload).processId);
    assert.ok(policyShowProcessId, "policyctl process.start should return processId");
    for (let i = 0; i < 20; i += 1) {
      const statusRes = await sendGatewayRequest({
        ws: wsRef!,
        gatewayPrivateKey: gatewayKeys.privateKey,
        gatewaySender: "gateway:smoke",
        pendingResponses,
        nodePublicKey: parsedNodePublic.key,
        method: "process.status",
        params: {
          processId: policyShowProcessId,
        },
        timeoutMs: 10_000,
      });
      assert.equal(statusRes.ok, true, "process.status failed for policyctl process");
      const status = asString(asObject(statusRes.payload).status) ?? "";
      if (status === "completed" || status === "failed" || status === "cancelled") break;
      await sleep(100);
    }
    const policyShowProcessLogs = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.logs",
      params: {
        processId: policyShowProcessId,
      },
      timeoutMs: 10_000,
    });
    assert.equal(policyShowProcessLogs.ok, true, "process.logs failed for policyctl process");
    const policyShowLogText = asString(asObject(policyShowProcessLogs.payload).logs) ?? "";
    assert.match(policyShowLogText, /"action": "show"/, "policyctl process logs should include show output");

    const policySoftUpdate = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "nexus-policyctl apply-preset smoke-soft",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(policySoftUpdate.ok, true, "nexus-policyctl apply-preset smoke-soft failed");
    const policySoftOutput = asString(asObject(policySoftUpdate.payload).output) ?? "{}";
    const policySoftPayload = asObject(JSON.parse(policySoftOutput));
    assert.equal(
      asString(policySoftPayload.action),
      "apply-preset",
      "policyctl should report apply-preset action",
    );
    assert.equal(
      asBoolean(policySoftPayload.changed),
      true,
      "policyctl soft apply should report changed=true",
    );
    assert.equal(
      asString(policySoftPayload.defaultQuarantine),
      "soft",
      "policyctl soft apply should return defaultQuarantine=soft",
    );
    assert.equal(
      asString(policySoftPayload.firewallMode),
      "audit-only",
      "policyctl soft apply should switch firewallMode=audit-only for continuity tests",
    );
    const policyPath = path.join(stateDir, "hermes-policy.json");
    const persistedPolicySoft = asObject(JSON.parse(await fs.readFile(policyPath, "utf8")));
    assert.equal(
      asString(persistedPolicySoft.defaultQuarantine),
      "soft",
      "expected persisted hermes-policy.json to reflect soft quarantine",
    );
    assert.equal(
      asString(persistedPolicySoft.firewallMode),
      "audit-only",
      "expected persisted hermes-policy.json to reflect audit-only mode",
    );

    const firewallBootstrapStart = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.start",
      params: {
        tool: "system.run",
        args: {
          command: "echo firewall-session-bootstrap",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(firewallBootstrapStart.ok, true, "process.start for firewall bootstrap failed");
    const firewallBootstrapPayload = asObject(firewallBootstrapStart.payload);
    const stickyFirewallSession = asString(firewallBootstrapPayload.firewallSession);
    assert.ok(stickyFirewallSession, "expected process.start to return firewallSession");
    assert.equal(
      Boolean(firewallBootstrapPayload.firewallSessionReused),
      false,
      "initial firewall session should be freshly created",
    );
    assert.equal(
      asString(firewallBootstrapPayload.firewallQuarantine),
      "soft",
      "new firewall session should inherit soft quarantine from policy",
    );

    const firewallReuseStart = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.start",
      params: {
        tool: "system.run",
        args: {
          command: "echo firewall-session-reuse",
        },
        routing: {
          firewallSession: stickyFirewallSession,
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(firewallReuseStart.ok, true, "process.start with existing firewall session failed");
    const firewallReusePayload = asObject(firewallReuseStart.payload);
    assert.equal(
      asString(firewallReusePayload.firewallSession),
      stickyFirewallSession,
      "expected firewall session id to be reused",
    );
    assert.equal(
      Boolean(firewallReusePayload.firewallSessionReused),
      true,
      "expected firewallSessionReused=true for known session",
    );
    assert.equal(
      asString(firewallReusePayload.firewallQuarantine),
      "soft",
      "reused firewall session should preserve soft quarantine",
    );

    const policyHardUpdate = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "nexus-policyctl apply-preset smoke-hard",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(policyHardUpdate.ok, true, "nexus-policyctl apply-preset smoke-hard failed");
    const persistedPolicyHard = asObject(JSON.parse(await fs.readFile(policyPath, "utf8")));
    assert.equal(
      asString(persistedPolicyHard.defaultQuarantine),
      "hard",
      "expected persisted hermes-policy.json to reflect hard quarantine",
    );

    const unknownFirewallSession = `fw-missing-${randomUUID().slice(0, 8)}`;
    const firewallMissingStart = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.start",
      params: {
        tool: "system.run",
        args: {
          command: "echo firewall-session-replaced",
        },
        routing: {
          firewallSession: unknownFirewallSession,
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(firewallMissingStart.ok, true, "process.start with missing firewall session failed");
    const firewallMissingPayload = asObject(firewallMissingStart.payload);
    const replacementFirewallSession = asString(firewallMissingPayload.firewallSession);
    assert.ok(
      replacementFirewallSession && replacementFirewallSession !== unknownFirewallSession,
      "expected missing firewall session to be replaced with a new session id",
    );
    assert.equal(
      Boolean(firewallMissingPayload.firewallSessionReused),
      false,
      "expected firewallSessionReused=false when requested session is missing/expired",
    );
    assert.equal(
      asString(firewallMissingPayload.firewallQuarantine),
      "hard",
      "replacement firewall session should inherit hard quarantine from latest policy",
    );

    const streamProcStart = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.start",
      params: {
        tool: "system.run",
        args: {
          command: "echo stream-alpha",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(streamProcStart.ok, true, "process.start stream command failed");
    const streamProcessId = asString(asObject(streamProcStart.payload).processId);
    assert.ok(streamProcessId, "stream process missing processId");
    const streamProcessKey = streamProcessId as string;

    await waitForCondition({
      timeoutMs: 8_000,
      intervalMs: 100,
      message: "did not receive log.append output for streaming process",
      predicate: () => {
        const chunks = logAppendChunksByProcess.get(streamProcessKey) ?? [];
        return chunks.join("").includes("stream-alpha");
      },
    });
    const streamChunks = logAppendChunksByProcess.get(streamProcessKey) ?? [];
    assert.ok(streamChunks.length > 0, "expected at least one log.append chunk for streaming process");

    const streamStatusMid = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.status",
      params: {
        processId: streamProcessKey,
      },
      timeoutMs: 10_000,
    });
    assert.equal(streamStatusMid.ok, true, "process.status for streaming process failed");
    const streamStatusMidValue = asString(asObject(streamStatusMid.payload).status) ?? "";
    assert.ok(
      streamStatusMidValue === "queued" || streamStatusMidValue === "running" || streamStatusMidValue === "completed",
      `unexpected streaming process status=${streamStatusMidValue || "<empty>"}`,
    );

    let streamFinalStatus = "";
    for (let i = 0; i < 30; i += 1) {
      const statusRes = await sendGatewayRequest({
        ws: wsRef!,
        gatewayPrivateKey: gatewayKeys.privateKey,
        gatewaySender: "gateway:smoke",
        pendingResponses,
        nodePublicKey: parsedNodePublic.key,
        method: "process.status",
        params: {
          processId: streamProcessKey,
        },
        timeoutMs: 10_000,
      });
      assert.equal(statusRes.ok, true, "process.status polling for streaming process failed");
      streamFinalStatus = asString(asObject(statusRes.payload).status) ?? "";
      if (streamFinalStatus === "completed" || streamFinalStatus === "failed" || streamFinalStatus === "cancelled") break;
      await sleep(100);
    }
    assert.equal(streamFinalStatus, "completed", `expected streaming process to complete, got ${streamFinalStatus}`);
    const streamLogs = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.logs",
      params: {
        processId: streamProcessKey,
        maxChars: 4000,
      },
      timeoutMs: 10_000,
    });
    assert.equal(streamLogs.ok, true, "process.logs for streaming process failed");
    const streamLogText = asString(asObject(streamLogs.payload).logs) ?? "";
    assert.match(
      streamLogText,
      /Sanitized output withheld by firewall mode/,
      "audit-only process logs should return sanitized summaries",
    );
    assert.ok(!streamLogText.includes("stream-alpha"), "sanitized process.logs must not leak raw output");

    suppressNextTerminalAck = true;
    const replayProcStart = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.start",
      params: {
        tool: "system.run",
        args: {
          command: "echo replay-me",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(replayProcStart.ok, true, "process.start replay process failed");
    const replayProcessId = asString(asObject(replayProcStart.payload).processId);
    assert.ok(replayProcessId, "replay process missing processId");
    for (let i = 0; i < 20; i += 1) {
      const statusRes = await sendGatewayRequest({
        ws: wsRef!,
        gatewayPrivateKey: gatewayKeys.privateKey,
        gatewaySender: "gateway:smoke",
        pendingResponses,
        nodePublicKey: parsedNodePublic.key,
        method: "process.status",
        params: {
          processId: replayProcessId,
        },
        timeoutMs: 10_000,
      });
      assert.equal(statusRes.ok, true, "process.status for replay process failed");
      const status = asString(asObject(statusRes.payload).status) ?? "";
      if (status === "completed" || status === "failed" || status === "cancelled") break;
      await sleep(100);
    }
    await waitForCondition({
      timeoutMs: 10_000,
      intervalMs: 100,
      message: "did not observe terminal delivery id for replay process",
      predicate: () => Boolean(withheldDeliveryId),
    });

    const longProcStart = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.start",
      params: {
        tool: "system.run",
        args: {
          command: "sleep 20",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(longProcStart.ok, true, "process.start long command failed");
    const longProcessId = asString(asObject(longProcStart.payload).processId);
    assert.ok(longProcessId, "long process missing processId");

    const wsBeforeFailover = wsRef;
    assert.ok(wsBeforeFailover, "expected open websocket before failover");
    (wsBeforeFailover as WebSocket).close(1012, "simulate gateway failover");
    await timeoutPromise(reconnectHandshakeComplete.promise, 20_000, "reconnect handshake did not complete");
    await timeoutPromise(reconnectReady.promise, 20_000, "node did not advertise capabilities after reconnect");
    assert.ok(wsRef, "reconnected websocket missing");
    assert.notEqual(wsRef, wsBeforeFailover, "expected new websocket after failover");

    const reconnectStatus = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.status",
      params: {
        processId: longProcessId,
      },
      timeoutMs: 10_000,
    });
    assert.equal(reconnectStatus.ok, true, "process.status failed after reconnect");
    const reconnectProcessStatus = asString(asObject(reconnectStatus.payload).status) ?? "";
    assert.notEqual(reconnectProcessStatus, "", "missing process status after reconnect");

    const reconnectLogs = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.logs",
      params: {
        processId: longProcessId,
        maxChars: 4000,
      },
      timeoutMs: 10_000,
    });
    assert.equal(reconnectLogs.ok, true, "process.logs failed after reconnect");
    const reconnectLogsPayload = asObject(reconnectLogs.payload);
    assert.equal(typeof reconnectLogsPayload.logs, "string", "expected logs payload to include logs text");
    const firewallReconnectStart = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.start",
      params: {
        tool: "system.run",
        args: {
          command: "echo firewall-session-reconnect",
        },
        routing: {
          firewallSession: stickyFirewallSession,
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(
      firewallReconnectStart.ok,
      true,
      "process.start with persisted firewall session after reconnect failed",
    );
    const firewallReconnectPayload = asObject(firewallReconnectStart.payload);
    assert.equal(
      asString(firewallReconnectPayload.firewallSession),
      stickyFirewallSession,
      "expected firewall session continuity across reconnect/failover",
    );
    assert.equal(
      Boolean(firewallReconnectPayload.firewallSessionReused),
      true,
      "expected firewall session to be reused after reconnect",
    );
    assert.equal(
      asString(firewallReconnectPayload.firewallQuarantine),
      "soft",
      "reused sticky firewall session should keep its original quarantine state",
    );
    await waitForCondition({
      timeoutMs: 10_000,
      intervalMs: 100,
      message: "withheld terminal delivery was not replayed after reconnect",
      predicate: () => replayedWithheldDelivery,
    });

    const cancelRes = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.cancel",
      params: {
        processId: longProcessId,
        signal: "SIGTERM",
        killAfterMs: 1000,
      },
      timeoutMs: 10_000,
    });
    assert.equal(cancelRes.ok, true, "process.cancel failed");

    let finalLongStatus = "";
    for (let i = 0; i < 40; i += 1) {
      const statusRes = await sendGatewayRequest({
        ws: wsRef!,
        gatewayPrivateKey: gatewayKeys.privateKey,
        gatewaySender: "gateway:smoke",
        pendingResponses,
        nodePublicKey: parsedNodePublic.key,
        method: "process.status",
        params: {
          processId: longProcessId,
        },
        timeoutMs: 10_000,
      });
      assert.equal(statusRes.ok, true, "process.status for long process failed");
      finalLongStatus = asString(asObject(statusRes.payload).status) ?? "";
      if (finalLongStatus === "cancelled" || finalLongStatus === "completed" || finalLongStatus === "failed") break;
      await sleep(125);
    }
    assert.equal(finalLongStatus, "cancelled", `expected long process cancelled, got ${finalLongStatus}`);

    const policyAuditOnlyUpdate = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "nexus-policyctl set-mode audit-only",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(policyAuditOnlyUpdate.ok, true, "nexus-policyctl set-mode audit-only failed");
    const persistedPolicyAuditOnly = asObject(JSON.parse(await fs.readFile(policyPath, "utf8")));
    assert.equal(
      asString(persistedPolicyAuditOnly.firewallMode),
      "audit-only",
      "policyctl set-mode should persist firewallMode=audit-only",
    );

    const auditOnlyRunRes = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "echo audit-only-output",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(auditOnlyRunRes.ok, true, "system.run failed in audit-only mode");
    const auditOnlyOutput = asString(asObject(auditOnlyRunRes.payload).output) ?? "{}";
    const auditOnlyStructured = asObject(JSON.parse(auditOnlyOutput));
    assert.equal(asString(auditOnlyStructured.mode), "audit-only", "audit-only run should return mode marker");
    assert.match(
      asString(auditOnlyStructured.safeSummary) ?? "",
      /Sanitized output withheld by firewall mode/,
      "audit-only run should return sanitized safe summary",
    );
    assert.ok(
      !(asString(auditOnlyStructured.safeSummary) ?? "").includes("audit-only-output"),
      "audit-only safe summary must not include raw command output",
    );
    assert.ok(
      ((auditOnlyStructured.references as Array<unknown> | undefined) ?? []).length > 0,
      "audit-only run should return at least one hermes reference",
    );

    const auditOnlyProcStart = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.start",
      params: {
        tool: "system.run",
        args: {
          command: "echo audit-only-process",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(auditOnlyProcStart.ok, true, "process.start failed in audit-only mode");
    const auditOnlyProcessId = asString(asObject(auditOnlyProcStart.payload).processId);
    assert.ok(auditOnlyProcessId, "audit-only process missing processId");
    for (let i = 0; i < 20; i += 1) {
      const statusRes = await sendGatewayRequest({
        ws: wsRef!,
        gatewayPrivateKey: gatewayKeys.privateKey,
        gatewaySender: "gateway:smoke",
        pendingResponses,
        nodePublicKey: parsedNodePublic.key,
        method: "process.status",
        params: {
          processId: auditOnlyProcessId,
        },
        timeoutMs: 10_000,
      });
      assert.equal(statusRes.ok, true, "process.status failed for audit-only process");
      const status = asString(asObject(statusRes.payload).status) ?? "";
      if (status === "completed" || status === "failed" || status === "cancelled") break;
      await sleep(100);
    }
    const auditOnlyProcLogs = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "process.logs",
      params: {
        processId: auditOnlyProcessId,
      },
      timeoutMs: 10_000,
    });
    assert.equal(auditOnlyProcLogs.ok, true, "process.logs failed in audit-only mode");
    const auditOnlyProcLogsPayload = asObject(auditOnlyProcLogs.payload);
    const auditOnlyHermes = asObject(auditOnlyProcLogsPayload.hermes);
    assert.equal(
      asBoolean(auditOnlyHermes.sanitized),
      true,
      "audit-only process logs should report hermes.sanitized=true",
    );
    assert.ok(
      ((auditOnlyHermes.references as Array<unknown> | undefined) ?? []).length > 0,
      "audit-only process logs should return hermes references",
    );

    const policyHermesUpdate = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "nexus-policyctl set-mode hermes",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(policyHermesUpdate.ok, true, "nexus-policyctl set-mode hermes failed");
    const persistedPolicyHermes = asObject(JSON.parse(await fs.readFile(policyPath, "utf8")));
    assert.equal(
      asString(persistedPolicyHermes.firewallMode),
      "hermes",
      "policyctl set-mode should persist firewallMode=hermes",
    );

    const hermesRunRes = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "echo {{user:displayName}}",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(hermesRunRes.ok, true, "system.run failed in hermes mode");
    const hermesOutput = asString(asObject(hermesRunRes.payload).output) ?? "{}";
    const hermesStructured = asObject(JSON.parse(hermesOutput));
    assert.equal(asString(hermesStructured.mode), "hermes", "hermes run should return mode marker");
    assert.match(
      asString(hermesStructured.safeSummary) ?? "",
      /Sanitized output withheld by firewall mode/,
      "hermes run should return sanitized safe summary",
    );
    assert.ok(
      !(asString(hermesStructured.safeSummary) ?? "").includes("Smoke User"),
      "hermes safe summary must not include resolved symbol plaintext",
    );
    assert.ok(
      ((hermesStructured.references as Array<unknown> | undefined) ?? []).length > 0,
      "hermes run should return at least one reference",
    );

    const hermesMissingSymbol = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "echo {{secret:missing-secret:token}}",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(hermesMissingSymbol.ok, false, "hermes mode should hard-fail unresolved symbols");
    assert.equal(asString(asObject(hermesMissingSymbol.error).code), "SYMBOL_RESOLUTION_FAILED");

    const policyHermesDenyUpdate = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "nexus-policyctl apply-preset smoke-hermes-deny-uname",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(policyHermesDenyUpdate.ok, true, "nexus-policyctl apply-preset smoke-hermes-deny-uname failed");
    const hermesDenyRunRes = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "uname -a",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(hermesDenyRunRes.ok, false, "hermes deny policy should block system.run command");
    assert.equal(asString(asObject(hermesDenyRunRes.error).code), "HERMES_POLICY_DENIED");
    assert.match(
      asString(asObject(hermesDenyRunRes.error).message) ?? "",
      /command_denied/,
      "hermes deny policy should return structured deny reason",
    );

    const denyClearBlocked = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "nexus-policyctl apply-preset smoke-hermes-clear-deny",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(denyClearBlocked.ok, false, "clearing denyCommands without break-glass should fail");
    assert.equal(asString(asObject(denyClearBlocked.error).code), "POLICY_MUTATION_DENIED");

    const denyClearBreakGlass = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "nexus-policyctl apply-preset smoke-hermes-clear-deny --break-glass",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(denyClearBreakGlass.ok, true, "clearing denyCommands with break-glass should succeed");

    const downgradeBlocked = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "nexus-policyctl set-mode transparent",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(downgradeBlocked.ok, false, "hermes->transparent downgrade without break-glass should fail");
    assert.equal(asString(asObject(downgradeBlocked.error).code), "POLICY_MUTATION_DENIED");

    const downgradeBreakGlass = await sendGatewayRequest({
      ws: wsRef!,
      gatewayPrivateKey: gatewayKeys.privateKey,
      gatewaySender: "gateway:smoke",
      pendingResponses,
      nodePublicKey: parsedNodePublic.key,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command: "nexus-policyctl set-mode transparent --break-glass",
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(downgradeBreakGlass.ok, true, "hermes->transparent downgrade with break-glass should succeed");
    const persistedPolicyTransparent = asObject(JSON.parse(await fs.readFile(policyPath, "utf8")));
    assert.equal(asString(persistedPolicyTransparent.firewallMode), "transparent");

    const tamperedWs = wsRef;
    assert.ok(tamperedWs, "websocket missing before tampered-signature test");
    const tamperedClose = deferred<{ code: number; reason: string }>();
    tamperedWs.once("close", (code, reasonRaw) => {
      tamperedClose.resolve({ code: Number(code), reason: String(reasonRaw || "") });
    });
    sendTamperedEnvelope(tamperedWs, gatewayKeys.privateKey, "gateway:smoke", {
      type: "event",
      event: "caps.advertise",
      payload: {
        capabilities: ["system.run"],
        tags: ["tampered-signature-test"],
        timestamp: Date.now(),
      },
    });
    const tamperedCloseResult = await timeoutPromise(
      tamperedClose.promise,
      8_000,
      "node did not disconnect after receiving tampered gateway envelope",
    );
    assert.equal(
      tamperedCloseResult.code,
      4001,
      `expected auth disconnect code=4001 for tampered envelope, got ${tamperedCloseResult.code}`,
    );
    assert.ok(
      tamperedCloseResult.reason.includes("invalid gateway signature"),
      `expected invalid signature close reason, got: ${tamperedCloseResult.reason || "<none>"}`,
    );

    process.stdout.write(
      "[smoke] PASS: transport policy + bidirectional handshake proof rejection + signed handshake + symbols catalog/resolution + audit.query + process primitives (log stream + policyctl command gating + firewall session continuity) + firewall modes (transparent pass-through + audit-only/hermes sanitization + hermes deny enforcement + break-glass downgrade guards) + reconnect continuity + outbox replay + tamper rejection verified\n",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[smoke] FAIL: ${msg}\n`);
    if (childStdout.length > 0) {
      process.stderr.write("[smoke] child stdout:\n");
      process.stderr.write(childStdout.join(""));
      process.stderr.write("\n");
    }
    if (childStderr.length > 0) {
      process.stderr.write("[smoke] child stderr:\n");
      process.stderr.write(childStderr.join(""));
      process.stderr.write("\n");
    }
    process.exitCode = 1;
  } finally {
    for (const pending of pendingResponses.values()) {
      pending.reject(new Error("smoke shutting down"));
    }
    pendingResponses.clear();
    const openWs = wsRef;
    if (openWs) {
      try {
        (openWs as WebSocket).close(1000, "smoke complete");
      } catch {
        // ignore
      }
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await timeoutPromise(
        new Promise<void>((resolve) => child!.once("exit", () => resolve())),
        4_000,
        "reference node did not exit after SIGTERM",
      ).catch(() => {
        try {
          child!.kill("SIGKILL");
        } catch {
          // ignore
        }
      });
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function sendGatewayRequest(params: {
  ws: WebSocket;
  gatewayPrivateKey: KeyObject;
  gatewaySender: string;
  pendingResponses: Map<string, Deferred<ResponseEnvelope>>;
  nodePublicKey: KeyObject;
  method: string;
  params: unknown;
  timeoutMs: number;
}): Promise<ResponseEnvelope> {
  const id = randomUUID();
  const pending = deferred<ResponseEnvelope>();
  params.pendingResponses.set(id, pending);
  sendSignedEnvelope(params.ws, params.gatewayPrivateKey, params.gatewaySender, {
    type: "req",
    id,
    method: params.method,
    params: params.params,
  });
  const res = await timeoutPromise(pending.promise, params.timeoutMs, `request timeout method=${params.method}`);
  const resObj: Record<string, unknown> = {
    type: "res",
    id: res.id,
    ts: res.ts,
    sender: res.sender,
    sig: res.sig,
    ok: res.ok,
  };
  if (res.payload !== undefined) resObj.payload = res.payload;
  if (res.error !== undefined) resObj.error = res.error;
  assert.ok(
    verifyEnvelopeSignature(resObj, params.nodePublicKey),
    `response signature verification failed for method=${params.method}`,
  );
  return res;
}

function sendSignedEnvelope(
  ws: WebSocket,
  privateKey: KeyObject,
  sender: string,
  envelope:
    | { type: "req"; id: string; method: string; params?: unknown }
    | { type: "res"; id: string | null; ok: boolean; payload?: unknown; error?: unknown }
    | { type: "event"; event: string; payload?: unknown },
): void {
  const withMeta = {
    ...envelope,
    ts: Date.now(),
    sender,
  };
  const sig = signDetachedPayload(withMeta, privateKey);
  ws.send(JSON.stringify({ ...withMeta, sig }));
}

function sendTamperedEnvelope(
  ws: WebSocket,
  privateKey: KeyObject,
  sender: string,
  envelope:
    | { type: "req"; id: string; method: string; params?: unknown }
    | { type: "res"; id: string | null; ok: boolean; payload?: unknown; error?: unknown }
    | { type: "event"; event: string; payload?: unknown },
): void {
  const withMeta = {
    ...envelope,
    ts: Date.now(),
    sender,
  };
  const sig = signDetachedPayload(withMeta, privateKey);
  // Deliberately mutate signed content after signature generation.
  ws.send(JSON.stringify({ ...withMeta, ts: withMeta.ts + 1, sig }));
}

function verifyEnvelopeSignature(envelope: Record<string, unknown>, publicKey: KeyObject): boolean {
  const sig = asString(envelope.sig);
  if (!sig) return false;
  return verifyDetachedPayload(withoutSig(envelope), sig, publicKey);
}

function buildHandshakeTranscript(params: {
  nodeId: string;
  sessionId: string;
  nodeNonce: string;
  gatewayNonce: string;
}): Record<string, unknown> {
  return {
    protocol: "nexus-node-v1",
    kind: "connect-proof",
    nodeId: params.nodeId,
    sessionId: params.sessionId,
    nodeNonce: params.nodeNonce,
    gatewayNonce: params.gatewayNonce,
  };
}

function parseEnvelope(value: Record<string, unknown>): Envelope | null {
  const type = asString(value.type);
  const ts = asNumber(value.ts);
  const sender = asString(value.sender);
  const sig = asString(value.sig);
  if (!type || !ts || !sender || !sig) return null;
  if (type === "req") {
    const id = asString(value.id);
    const method = asString(value.method);
    if (!id || !method) return null;
    return { type: "req", id, ts, sender, sig, method, params: value.params };
  }
  if (type === "res") {
    if (typeof value.ok !== "boolean") return null;
    const error = value.error === undefined ? undefined : asObject(value.error);
    return {
      type: "res",
      id: asString(value.id),
      ts,
      sender,
      sig,
      ok: value.ok,
      payload: value.payload,
      error,
    };
  }
  if (type === "event") {
    const event = asString(value.event);
    if (!event) return null;
    return { type: "event", ts, sender, sig, event, payload: value.payload };
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value !== "boolean") return null;
  return value;
}

function asNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function toBase64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Loose(value: string): Buffer | null {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized || /[^A-Za-z0-9+/=]/.test(normalized)) return null;
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function withoutSig(value: Record<string, unknown>): Record<string, unknown> {
  const { sig: _sig, ...rest } = value;
  return rest;
}

function signDetachedPayload(payload: unknown, privateKey: KeyObject): string {
  const bytes = Buffer.from(stableStringify(payload), "utf8");
  return toBase64Url(sign(null, bytes, privateKey));
}

function verifyDetachedPayload(payload: unknown, signature: string, publicKey: KeyObject): boolean {
  const sigBytes = decodeBase64Loose(signature);
  if (!sigBytes) return false;
  const bytes = Buffer.from(stableStringify(payload), "utf8");
  try {
    return verify(null, bytes, publicKey, sigBytes);
  } catch {
    return false;
  }
}

function parsePublicKey(value: string): ParsedPublicKey | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let key: KeyObject | null = null;
  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    try {
      key = createPublicKey(trimmed);
    } catch {
      key = null;
    }
  }
  if (!key) {
    const decoded = decodeBase64Loose(trimmed);
    if (!decoded) return null;
    if (decoded.length === 32) {
      try {
        key = createPublicKey({
          key: Buffer.concat([ED25519_SPKI_RAW_PREFIX, decoded]),
          format: "der",
          type: "spki",
        });
      } catch {
        key = null;
      }
    } else {
      try {
        key = createPublicKey({ key: decoded, format: "der", type: "spki" });
      } catch {
        key = null;
      }
    }
  }
  if (!key || key.asymmetricKeyType !== "ed25519") return null;
  const raw = publicKeyRaw(key);
  if (!raw) return null;
  return {
    key,
    raw: toBase64Url(raw),
    fingerprint: createHash("sha256").update(raw).digest("hex"),
  };
}

function publicKeyRaw(publicKey: KeyObject): Buffer | null {
  try {
    const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    if (der.length !== ED25519_SPKI_RAW_PREFIX.length + 32) return null;
    if (!der.subarray(0, ED25519_SPKI_RAW_PREFIX.length).equals(ED25519_SPKI_RAW_PREFIX)) return null;
    return der.subarray(ED25519_SPKI_RAW_PREFIX.length);
  } catch {
    return null;
  }
}

void main();
