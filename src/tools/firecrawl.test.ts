import assert from "node:assert/strict";
import test from "node:test";

import { clearResolvedSecretsForTests, hydrateResolvedSecrets } from "../secrets/resolve-env.js";
import {
  DEFAULT_FIRECRAWL_BASE_URL,
  firecrawlBaseUrl,
  firecrawlConfigured,
  firecrawlHeaders,
  firecrawlScrape,
  firecrawlUrl,
} from "./firecrawl.js";

/** Run `fn` with only the given secrets resolved, then reset the registry. */
async function withSecrets(
  secrets: Record<string, string>,
  fn: () => void | Promise<void>,
): Promise<void> {
  clearResolvedSecretsForTests();
  hydrateResolvedSecrets(secrets);
  try {
    await fn();
  } finally {
    clearResolvedSecretsForTests();
  }
}

test("firecrawlBaseUrl defaults to the cloud API when unconfigured", async () => {
  await withSecrets({}, () => {
    assert.equal(firecrawlBaseUrl(), DEFAULT_FIRECRAWL_BASE_URL);
  });
});

test("firecrawlBaseUrl uses a custom URL and strips trailing slashes", async () => {
  await withSecrets({ FIRECRAWL_API_URL: "http://192.168.122.1:3002///" }, () => {
    assert.equal(firecrawlBaseUrl(), "http://192.168.122.1:3002");
  });
});

test("firecrawlConfigured is false with no key and no custom URL", async () => {
  await withSecrets({}, () => {
    assert.equal(firecrawlConfigured(), false);
  });
});

test("firecrawlConfigured is false when the custom URL just equals the default", async () => {
  await withSecrets({ FIRECRAWL_API_URL: DEFAULT_FIRECRAWL_BASE_URL }, () => {
    assert.equal(firecrawlConfigured(), false);
  });
});

test("firecrawlConfigured is true with a self-hosted URL and no key", async () => {
  await withSecrets({ FIRECRAWL_API_URL: "http://192.168.122.1:3002" }, () => {
    assert.equal(firecrawlConfigured(), true);
  });
});

test("firecrawlConfigured is true with a cloud API key and no URL", async () => {
  await withSecrets({ FIRECRAWL_API_KEY: "fc-test-key" }, () => {
    assert.equal(firecrawlConfigured(), true);
  });
});

test("firecrawlHeaders omits Authorization when no key is set", async () => {
  await withSecrets({ FIRECRAWL_API_URL: "http://192.168.122.1:3002" }, () => {
    const headers = firecrawlHeaders();
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal("Authorization" in headers, false);
  });
});

test("firecrawlHeaders includes bearer auth when a key is set", async () => {
  await withSecrets({ FIRECRAWL_API_KEY: "fc-test-key" }, () => {
    assert.equal(firecrawlHeaders().Authorization, "Bearer fc-test-key");
  });
});

test("firecrawlUrl builds v1 endpoints from the resolved base", async () => {
  await withSecrets({ FIRECRAWL_API_URL: "http://192.168.122.1:3002/" }, () => {
    assert.equal(firecrawlUrl("search"), "http://192.168.122.1:3002/v1/search");
    assert.equal(firecrawlUrl("scrape"), "http://192.168.122.1:3002/v1/scrape");
  });
});

test("firecrawlScrape returns null when Firecrawl is not configured", async () => {
  await withSecrets({}, async () => {
    assert.equal(await firecrawlScrape("https://example.com", { timeoutMs: 5000 }), null);
  });
});

test("firecrawlScrape returns parsed markdown on a successful response", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ success: true, data: { markdown: "# Hello", metadata: { title: "Hello" } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    await withSecrets({ FIRECRAWL_API_URL: "http://192.168.122.1:3002" }, async () => {
      const result = await firecrawlScrape("https://example.com", { timeoutMs: 5000 });
      assert.equal(result?.markdown, "# Hello");
      assert.equal(result?.metadata?.title, "Hello");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("firecrawlScrape returns null on a non-2xx response", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream error", { status: 502 });
  try {
    await withSecrets({ FIRECRAWL_API_URL: "http://192.168.122.1:3002" }, async () => {
      assert.equal(await firecrawlScrape("https://example.com", { timeoutMs: 5000 }), null);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
