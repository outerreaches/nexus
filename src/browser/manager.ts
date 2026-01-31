import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type { Browser, BrowserContext, Page } from "playwright-core";

import { findBrowserExecutable } from "./executable.js";

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForCdpReady(params: { port: number; timeoutMs: number }): Promise<void> {
  const url = `http://127.0.0.1:${params.port}/json/version`;
  const start = Date.now();
  while (Date.now() - start < params.timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // ignore
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for CDP on ${url}`);
}

type SnapshotItem = { ref: string; role: string; tag?: string; type?: string; name: string };

export class BrowserManager {
  private proc: ChildProcess | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;

  constructor(
    private readonly cfg: {
      stateDir: string;
      cdpPort: number;
      remoteCdpUrl?: string;
      headless: boolean;
      noSandbox: boolean;
    },
  ) {}

  private get userDataDir(): string {
    return path.join(this.cfg.stateDir, "browser", "default");
  }

  private get screenshotsDir(): string {
    return path.join(this.cfg.stateDir, "browser", "screenshots");
  }

  async ensureStarted(): Promise<void> {
    if (this.browser && this.context) return;

    if (this.cfg.remoteCdpUrl) {
      const { chromium } = await import("playwright-core");
      this.browser = await chromium.connectOverCDP(this.cfg.remoteCdpUrl);
      this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
      this.activePage = this.context.pages()[0] ?? (await this.context.newPage());
      return;
    }

    await fs.mkdir(this.userDataDir, { recursive: true });
    const executablePath = await findBrowserExecutable();

    const args = [
      `--remote-debugging-port=${this.cfg.cdpPort}`,
      `--user-data-dir=${this.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disable-popup-blocking",
      "--disable-features=TranslateUI",
    ];
    if (process.platform === "linux") args.push("--disable-gpu");
    if (this.cfg.noSandbox) args.push("--no-sandbox");
    if (this.cfg.headless) args.push("--headless=new");
    args.push("about:blank");

    this.proc = spawn(executablePath, args, {
      stdio: "ignore",
    });
    this.proc.on("exit", () => {
      this.proc = null;
      this.browser = null;
      this.context = null;
      this.activePage = null;
    });

    await waitForCdpReady({ port: this.cfg.cdpPort, timeoutMs: 15_000 });

    const { chromium } = await import("playwright-core");
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cfg.cdpPort}`);
    this.context = this.browser.contexts()[0] ?? null;
    if (!this.context) throw new Error("No browser context available.");
    this.activePage = this.context.pages()[0] ?? (await this.context.newPage());
  }

  async start(): Promise<void> {
    await this.ensureStarted();
  }

  async stop(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      // ignore
    }
    try {
      await this.browser?.close();
    } catch {
      // ignore
    }
    try {
      this.proc?.kill("SIGTERM");
    } catch {
      // ignore
    }
    this.proc = null;
    this.browser = null;
    this.context = null;
    this.activePage = null;
  }

  async status(): Promise<Record<string, unknown>> {
    const started = !!this.browser;
    const pages = this.context ? this.context.pages().length : 0;
    const url = this.activePage ? this.activePage.url() : null;
    return {
      started,
      cdpPort: this.cfg.cdpPort,
      remoteCdpUrl: this.cfg.remoteCdpUrl ?? null,
      userDataDir: this.userDataDir,
      pages,
      activeUrl: url,
    };
  }

  async tabs(): Promise<Array<{ index: number; url: string; title: string; active: boolean }>> {
    await this.ensureStarted();
    if (!this.context) throw new Error("Browser context unavailable.");
    const pages = this.context.pages();
    const out: Array<{ index: number; url: string; title: string; active: boolean }> = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i]!;
      const url = p.url();
      const title = await p.title().catch(() => "");
      out.push({ index: i, url, title, active: p === this.activePage });
    }
    return out;
  }

  async focus(index: number): Promise<string> {
    await this.ensureStarted();
    if (!this.context) throw new Error("Browser context unavailable.");
    const pages = this.context.pages();
    const page = pages[index];
    if (!page) throw new Error(`No tab at index ${index}`);
    this.activePage = page;
    await page.bringToFront().catch(() => {});
    return "OK";
  }

  async close(index: number): Promise<string> {
    await this.ensureStarted();
    if (!this.context) throw new Error("Browser context unavailable.");
    const pages = this.context.pages();
    const page = pages[index];
    if (!page) throw new Error(`No tab at index ${index}`);
    await page.close().catch(() => {});
    const remaining = this.context.pages();
    this.activePage = remaining[0] ?? null;
    if (!this.activePage) this.activePage = await this.context.newPage();
    return "OK";
  }

  async openUrl(url: string, newTab: boolean): Promise<string> {
    await this.ensureStarted();
    if (!this.context) throw new Error("Browser context unavailable.");
    const page = newTab ? await this.context.newPage() : (this.activePage ?? (await this.context.newPage()));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    this.activePage = page;
    return `OK: opened ${url}`;
  }

  async navigate(url: string): Promise<string> {
    await this.ensureStarted();
    if (!this.activePage) throw new Error("No active page.");
    await this.activePage.goto(url, { waitUntil: "domcontentloaded" });
    return `OK: navigated ${url}`;
  }

  async snapshot(maxElements: number): Promise<string> {
    await this.ensureStarted();
    if (!this.activePage) throw new Error("No active page.");

    const { title, url, items } = await this.activePage.evaluate((max) => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            "a[href]",
            "button",
            "input:not([type='hidden'])",
            "textarea",
            "select",
            "[role='button']",
            "[role='link']",
            "[role='textbox']",
            "[contenteditable='true']",
          ].join(","),
        ),
      ) as HTMLElement[];

      // Clear old refs (best-effort).
      for (const el of document.querySelectorAll("[data-nexus-ref]")) {
        (el as HTMLElement).removeAttribute("data-nexus-ref");
      }

      const items = candidates.slice(0, max).map((el, idx) => {
        const ref = `e${idx + 1}`;
        el.setAttribute("data-nexus-ref", ref);
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "button" ? "button" : tag);
        const type = tag === "input" ? (el.getAttribute("type") || "text") : undefined;
        const name =
          el.getAttribute("aria-label") ||
          el.getAttribute("alt") ||
          (el as any).placeholder ||
          (el.innerText || el.textContent || "").trim();
        return { ref, role, tag, type, name: (name || "").slice(0, 140) };
      });

      return { title: document.title, url: location.href, items };
    }, maxElements);

    const lines: string[] = [`URL: ${url}`, `TITLE: ${title}`, "", "ELEMENTS:"];
    for (const it of items as SnapshotItem[]) {
      const typePart = it.type ? ` type=${it.type}` : "";
      const tagPart = it.tag ? ` tag=${it.tag}` : "";
      lines.push(`[${it.ref}] role=${it.role}${tagPart}${typePart} name="${it.name.replace(/"/g, '\\"')}"`);
    }
    return lines.join("\n");
  }

  async click(ref: string): Promise<string> {
    await this.ensureStarted();
    if (!this.activePage) throw new Error("No active page.");
    const loc = this.activePage.locator(`[data-nexus-ref="${ref}"]`).first();
    await loc.click({ timeout: 10_000 });
    return "OK";
  }

  async type(ref: string, text: string, submit: boolean): Promise<string> {
    await this.ensureStarted();
    if (!this.activePage) throw new Error("No active page.");
    const loc = this.activePage.locator(`[data-nexus-ref="${ref}"]`).first();
    await loc.fill(text, { timeout: 10_000 });
    if (submit) await loc.press("Enter");
    return "OK";
  }

  async text(maxChars: number): Promise<string> {
    await this.ensureStarted();
    if (!this.activePage) throw new Error("No active page.");
    const text = await this.activePage.evaluate(() => {
      const el = document.body;
      return (el?.innerText || "").trim();
    });
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[truncated]` : text;
  }

  async screenshot(params: { fileName?: string; fullPage: boolean }): Promise<string> {
    await this.ensureStarted();
    if (!this.activePage) throw new Error("No active page.");
    await fs.mkdir(this.screenshotsDir, { recursive: true });
    const fileName = params.fileName?.trim()
      ? params.fileName.trim().replace(/[^a-zA-Z0-9_.-]+/g, "_")
      : `${Date.now()}.png`;
    const filePath = path.join(this.screenshotsDir, fileName);
    await this.activePage.screenshot({ path: filePath, fullPage: params.fullPage });
    return filePath;
  }

  async scroll(deltaY: number): Promise<string> {
    await this.ensureStarted();
    if (!this.activePage) throw new Error("No active page.");
    await this.activePage.evaluate((dy) => window.scrollBy(0, dy), deltaY);
    return "OK";
  }

  async press(key: string): Promise<string> {
    await this.ensureStarted();
    if (!this.activePage) throw new Error("No active page.");
    await this.activePage.keyboard.press(key);
    return "OK";
  }

  async wait(params: {
    kind: "domcontentloaded" | "networkidle" | "selector" | "text" | "url_includes" | "title_includes";
    value?: string;
    timeoutMs: number;
  }): Promise<string> {
    await this.ensureStarted();
    if (!this.activePage) throw new Error("No active page.");

    switch (params.kind) {
      case "domcontentloaded":
        await this.activePage.waitForLoadState("domcontentloaded", { timeout: params.timeoutMs });
        return "OK";
      case "networkidle":
        await this.activePage.waitForLoadState("networkidle", { timeout: params.timeoutMs });
        return "OK";
      case "selector": {
        const sel = params.value?.trim();
        if (!sel) throw new Error("wait selector requires value");
        await this.activePage.locator(sel).first().waitFor({ timeout: params.timeoutMs });
        return "OK";
      }
      case "text": {
        const t = params.value?.trim();
        if (!t) throw new Error("wait text requires value");
        await this.activePage.getByText(t).first().waitFor({ timeout: params.timeoutMs });
        return "OK";
      }
      case "url_includes": {
        const part = params.value?.trim();
        if (!part) throw new Error("wait url_includes requires value");
        await this.activePage.waitForURL((u) => u.toString().includes(part), { timeout: params.timeoutMs });
        return "OK";
      }
      case "title_includes": {
        const part = params.value?.trim();
        if (!part) throw new Error("wait title_includes requires value");
        const start = Date.now();
        while (Date.now() - start < params.timeoutMs) {
          const title = await this.activePage.title().catch(() => "");
          if (title.includes(part)) return "OK";
          await sleep(200);
        }
        throw new Error(`Timed out waiting for title to include: ${part}`);
      }
      default:
        throw new Error("Unknown wait kind");
    }
  }

  async clickText(text: string, timeoutMs: number = 10_000): Promise<string> {
    await this.ensureStarted();
    if (!this.activePage) throw new Error("No active page.");
    const needle = text.trim();
    if (!needle) throw new Error("clickText requires non-empty text");

    const perAttemptTimeout = Math.max(500, Math.min(3_000, timeoutMs));
    const candidates = [
      this.activePage.getByRole("button", { name: needle }),
      this.activePage.getByRole("link", { name: needle }),
      this.activePage
        .locator("button, a, input[type='submit'], [role='button'], [role='link']")
        .filter({ hasText: needle }),
    ];

    for (const loc of candidates) {
      try {
        await loc.first().click({ timeout: perAttemptTimeout });
        return "OK";
      } catch {
        // try next strategy
      }
    }

    throw new Error(`No clickable element found containing text: ${needle}`);
  }
}
