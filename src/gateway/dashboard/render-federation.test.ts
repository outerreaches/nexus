import assert from "node:assert/strict";
import test from "node:test";

import { renderDashboard } from "./render.js";

test("dashboard renders federation runtime status fields", () => {
  const nowMs = 1_700_000_000_000;
  const html = renderDashboard({
    status: {
      mode: "active",
      runtime: { profile: "primary" },
      federation: {
        enabled: true,
        derivedState: "active_federated",
        trustedPeerCount: 2,
        healthyTrustedPeerCount: 1,
        identityValid: true,
        firewallActive: false,
      },
      proactive: { enabled: false },
      llm: { modelMode: "default", localProvider: "local", localModel: "test-model" },
      activeLease: {
        key: "gateway_active",
        holderId: "test",
        held: true,
        expiresAt: nowMs + 1000,
        ttlMs: 45_000,
        renewMs: 15_000,
      },
    },
    nowMs,
    processWindowMinutes: 60,
    agentWindowMinutes: 60,
    visibleNodeWindowSeconds: 60,
    nodeLimit: 100,
    jobLimit: 50,
    runLimit: 50,
    blackboardLimit: 50,
    dataIntakeLimit: 50,
    hideOrphanData: false,
    processes: [],
    agents: { active: [], recent: [] },
    agentGraph: [],
    nodes: [],
    jobs: [],
    runningJobRuns: [],
    dataIntake: { enabled: false, targets: [], rows: [], sources: [], hideOrphans: false },
    dataIntakeCatalog: [],
    mcp: { available: false, servers: [], profiles: [], grants: [], events: [] },
    blackboard: [],
    blackboardScope: "all",
    blackboardScopes: [],
    db: undefined,
  });

  assert.ok(html.includes("Runtime Profile"));
  assert.ok(html.includes("Federation State"));
  assert.ok(html.includes("active_federated"));
  assert.ok(html.includes("Trusted Peers"));
});
