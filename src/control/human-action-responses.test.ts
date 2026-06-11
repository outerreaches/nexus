import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeQuickResponseCallback,
  encodeQuickResponseCallback,
  findHumanActionIds,
  quickResponsesForHumanAction,
} from "./human-action-responses.js";

test("quickResponsesForHumanAction offers approve/deny only for pending confirm actions", () => {
  const confirm = quickResponsesForHumanAction({ kind: "confirm", status: "pending" });
  assert.ok(confirm);
  assert.deepEqual(confirm!.map((o) => o.response), ["approve", "deny"]);

  assert.equal(quickResponsesForHumanAction({ kind: "input", status: "pending" }), null);
  assert.equal(quickResponsesForHumanAction({ kind: "confirm", status: "fulfilled" }), null);
  assert.equal(quickResponsesForHumanAction({ kind: "confirm", status: "expired" }), null);
});

test("findHumanActionIds extracts unique ids and ignores lookalikes", () => {
  const text = [
    "Deploy approval required.",
    "ID: HABCDEFGHJK2",
    "Reply with /act HABCDEFGHJK2 approve — or for the other one, /act HA23456789AB deny.",
    "Not ids: HABCDEFGHIJK (contains I), HA1234 (too short), PREFIXHABCDEFGHJK2 (embedded).",
  ].join("\n");
  const ids = findHumanActionIds(text);
  assert.deepEqual(ids.sort(), ["HA23456789AB", "HABCDEFGHJK2"]);
});

test("callback payloads round-trip and reject malformed data", () => {
  const encoded = encodeQuickResponseCallback("HABCDEFGHJK2", "approve");
  assert.equal(encoded, "ha:HABCDEFGHJK2:approve");
  assert.ok(encoded.length <= 64, "telegram callback_data limit");
  assert.deepEqual(decodeQuickResponseCallback(encoded), { id: "HABCDEFGHJK2", response: "approve" });

  assert.equal(decodeQuickResponseCallback("ha:HABCDEFGHJK2:rm -rf /"), null);
  assert.equal(decodeQuickResponseCallback("ha:NOTANID:approve"), null);
  assert.equal(decodeQuickResponseCallback("other:HABCDEFGHJK2:approve"), null);
  assert.equal(decodeQuickResponseCallback(""), null);
});
