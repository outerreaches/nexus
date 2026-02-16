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

async function main(): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-node-smoke-"));
  const nodeId = `smoke-node-${randomUUID().slice(0, 8)}`;
  const sessionId = `sess-${randomUUID().slice(0, 12)}`;
  const gatewayNonce = randomBytes(32).toString("base64url");
  const gatewayKeys = generateKeyPairSync("ed25519");
  const gatewayPubRaw = publicKeyRaw(gatewayKeys.publicKey);
  assert.ok(gatewayPubRaw, "failed to derive gateway public key");
  const gatewayPublicKeyRaw = toBase64Url(gatewayPubRaw);
  const gatewayFingerprint = createHash("sha256").update(gatewayPubRaw).digest("hex");

  let child: ChildProcessWithoutNullStreams | null = null;
  const childStdout: string[] = [];
  const childStderr: string[] = [];
  const pendingResponses = new Map<string, Deferred<ResponseEnvelope>>();
  const ready = deferred<void>();
  const handshakeComplete = deferred<void>();
  const nodePublicKeyDeferred = deferred<ParsedPublicKey>();

  let wsRef: WebSocket | null = null;
  let nodeNonce: string | null = null;
  let nodePublic: ParsedPublicKey | null = null;
  let nodeSender: string | null = null;

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
    child = spawn(
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
        "echo,uname,whoami,pwd,date,ls",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout.on("data", (chunk) => {
      childStdout.push(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      childStderr.push(String(chunk));
    });

    wss.on("connection", (ws) => {
      wsRef = ws;
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

            nodePublic = parsedPublic;
            nodeSender = msg.sender;
            nodeNonce = asString(params.nodeNonce);
            assert.ok(nodeNonce, "connect.hello missing nodeNonce");
            nodePublicKeyDeferred.resolve(parsedPublic);

            const transcript = buildHandshakeTranscript({
              nodeId: helloNodeId ?? nodeId,
              sessionId,
              nodeNonce: nodeNonce!,
              gatewayNonce,
            });
            const gatewayProofSig = signDetachedPayload(transcript, gatewayKeys.privateKey);

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

            const transcript = buildHandshakeTranscript({
              nodeId,
              sessionId,
              nodeNonce: nodeNonce!,
              gatewayNonce,
            });
            assert.ok(
              verifyDetachedPayload(transcript, nodeProofSig!, nodePublic!.key),
              "node proof signature invalid",
            );

            sendSignedEnvelope(ws, gatewayKeys.privateKey, "gateway:smoke", {
              type: "event",
              event: "connect.accept",
              payload: {
                sessionId,
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
                sessionId,
                status: "ready",
              },
            });
            handshakeComplete.resolve();
            return;
          }

          if (!nodePublic) return;
          assert.equal(msg.sender, nodeSender);
          assert.ok(verifyEnvelopeSignature(envelopeObj, nodePublic.key), `invalid signed envelope for ${msg.type}`);

          if (msg.type === "event" && msg.event === "caps.advertise") {
            ready.resolve();
            return;
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
          ready.reject(wrapped);
          handshakeComplete.reject(wrapped);
          nodePublicKeyDeferred.reject(wrapped);
        }
      });
    });

    await timeoutPromise(handshakeComplete.promise, 12_000, "handshake did not complete");
    await timeoutPromise(ready.promise, 12_000, "node did not advertise capabilities");
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

    process.stdout.write("[smoke] PASS: signed handshake + system.which/system.run verified\n");
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
    if (wsRef && wsRef.readyState === WebSocket.OPEN) {
      try {
        wsRef.close(1000, "smoke complete");
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
