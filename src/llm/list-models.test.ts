import assert from "node:assert/strict";
import test from "node:test";

import {
  collectConfiguredModels,
  listProviderModels,
  mergeModelLists,
  parseModelIds,
} from "./list-models.js";
import { ConfigSchema } from "../state/config.js";

test("parseModelIds reads the { data: [...] } envelope", () => {
  const body = { object: "list", data: [{ id: "b-model" }, { id: "a-model" }] };
  assert.deepEqual(parseModelIds(body), ["a-model", "b-model"]);
});

test("parseModelIds tolerates bare arrays and string entries", () => {
  assert.deepEqual(parseModelIds(["z", "a", "a"]), ["a", "z"]);
});

test("parseModelIds falls back to name when id is absent", () => {
  assert.deepEqual(parseModelIds({ data: [{ name: "named-model" }] }), ["named-model"]);
});

test("parseModelIds returns empty for junk input", () => {
  assert.deepEqual(parseModelIds(null), []);
  assert.deepEqual(parseModelIds({ data: "nope" }), []);
  assert.deepEqual(parseModelIds(42), []);
});

test("listProviderModels skips dynamic / empty base URLs without a network call", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}");
  }) as unknown as typeof fetch;
  const res = await listProviderModels({ baseUrl: "dynamic", fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(called, false);
});

test("listProviderModels parses a successful response and sends the bearer token", async () => {
  let seenAuth: string | null = null;
  let seenUrl = "";
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenAuth = new Headers(init.headers).get("authorization");
    return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const res = await listProviderModels({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    fetchImpl,
  });
  assert.deepEqual(res, { ok: true, models: ["m1", "m2"] });
  assert.equal(seenUrl, "https://api.example.com/v1/models");
  assert.equal(seenAuth, "Bearer sk-test");
});

test("listProviderModels reports non-2xx as a graceful error", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
  const res = await listProviderModels({ baseUrl: "https://api.example.com/v1", fetchImpl });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /404/);
});

test("collectConfiguredModels gathers models targeting a provider from defaults and routing", () => {
  const config = ConfigSchema.parse({
    llm: {
      openaiCompat: { baseUrl: "https://default.example/v1", model: "default-model" },
      providers: {
        openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "openrouter-default" },
      },
      routing: {
        byPreset: {
          coder: { primary: { provider: "openrouter", model: "openai/gpt-5.3-codex" } },
          trader: { primary: { provider: "openrouter", model: "minimax/minimax-m2.5" } },
          other: { primary: { provider: "default", model: "should-not-appear" } },
        },
      },
      toolRouting: {
        default: {
          image_generate: { provider: "openrouter", model: "google/gemini-image" },
        },
      },
    },
  });
  assert.deepEqual(collectConfiguredModels(config, "openrouter"), [
    "google/gemini-image",
    "minimax/minimax-m2.5",
    "openai/gpt-5.3-codex",
    "openrouter-default",
  ]);
});

test("mergeModelLists unions and de-duplicates across sources", () => {
  assert.deepEqual(mergeModelLists(["b", "a"], ["a", "c"]), ["a", "b", "c"]);
});
