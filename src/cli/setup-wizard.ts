import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import dotenv from "dotenv";
import JSON5 from "json5";
import { runCommand as runCommandShared } from "./run-command.js";
import { createSharedTui } from "./tui.js";

type SetupWizardOptions = {
  root?: string;
  codeDir?: string;
  repoUrl?: string;
  nonInteractive?: boolean;
  yes?: boolean;
  dryRun?: boolean;
};

type SetupPaths = {
  rootDir: string;
  codeDir: string;
  stateDir: string;
  workspaceDir: string;
  configRoot: string;
  storeDir: string;
  configPath: string;
  gatewayEnvFile: string;
  sidecarEnvFile: string;
  watchdogEnvFile: string;
  tlsPemPath: string;
};

type SetupSecrets = {
  httpApiKey: string;
  dashboardPassword: string;
  secretctlPassword: string;
  credentialsKey: string;
  haApiKey: string;
};

type SetupState = {
  repoUrl: string;
  tlsSan: string;
  enableHaDeployer: boolean;
  paths: SetupPaths;
  secrets: SetupSecrets;
  existingCoreSecretsDetected: boolean;
  overwriteCoreSecrets: boolean;
  secretOnboarding: SecretOnboardingPlan;
};

type ProviderPreset = {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  envKey: string;
  credentialId: string;
  local?: boolean;
  apiKeyOptional?: boolean;
};

type ProviderSetup = {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  envKey: string;
  credentialId: string;
  apiKey?: string;
  local: boolean;
};

type SecretOnboardingPlan = {
  enabled: boolean;
  providers: ProviderSetup[];
  extraSecrets: SecretOnboardingEntry[];
  defaultProviderId?: string;
};

type SecretOnboardingEntry = {
  credentialId: string;
  label: string;
  envKeys: string[];
  value: string;
};

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "moonshotai/kimi-k2.5",
    envKey: "OPENROUTER_API_KEY",
    credentialId: "llm.openrouter.api",
  },
  {
    id: "fireworks",
    label: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    model: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    envKey: "FIREWORKS_API_KEY",
    credentialId: "llm.fireworks.api",
  },
  {
    id: "baseten",
    label: "Baseten",
    baseUrl: "https://bridge.baseten.co/v1",
    model: "MODEL_ID_HERE",
    envKey: "BASETEN_API_KEY",
    credentialId: "llm.baseten.api",
  },
  {
    id: "local",
    label: "Local OpenAI-Compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    envKey: "NEXUS_LOCAL_LLM_API_KEY",
    credentialId: "llm.local.api",
    local: true,
    apiKeyOptional: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    envKey: "OPENAI_API_KEY",
    credentialId: "llm.openai.api",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    envKey: "GROQ_API_KEY",
    credentialId: "llm.groq.api",
  },
  {
    id: "together",
    label: "Together",
    baseUrl: "https://api.together.xyz/v1",
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    envKey: "TOGETHER_API_KEY",
    credentialId: "llm.together.api",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-small-latest",
    envKey: "MISTRAL_API_KEY",
    credentialId: "llm.mistral.api",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    envKey: "DEEPSEEK_API_KEY",
    credentialId: "llm.deepseek.api",
  },
  {
    id: "xai",
    label: "xAI",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-3-mini",
    envKey: "XAI_API_KEY",
    credentialId: "llm.xai.api",
  },
];

const EXTRA_SECRET_PRESETS: Array<{ credentialId: string; label: string; envKeys: string[]; required?: boolean }> = [
  {
    credentialId: "telegram.bot.token",
    label: "Telegram bot token",
    envKeys: ["TELEGRAM_BOT_TOKEN"],
  },
  {
    credentialId: "search.brave.api",
    label: "Brave Search API key",
    envKeys: ["BRAVE_API_KEY"],
  },
  {
    credentialId: "twitter.auth.auth_token",
    label: "X/Twitter auth token",
    envKeys: ["AUTH_TOKEN", "TWITTER_AUTH_TOKEN"],
  },
  {
    credentialId: "twitter.auth.ct0",
    label: "X/Twitter ct0 cookie",
    envKeys: ["CT0", "TWITTER_CT0"],
  },
];

const tui = createSharedTui({ themeId: "terminal-green", colorEnabled: Boolean(stdout.isTTY) });

function banner(title: string, subtitle: string): void {
  process.stdout.write(`${tui.logoPanel(title, subtitle)}\n\n`);
}

function section(title: string): void {
  process.stdout.write(`${tui.section(title)}\n`);
}

function info(text: string): void {
  process.stdout.write(`${tui.info(text)}\n`);
}

function ok(text: string): void {
  process.stdout.write(`${tui.ok(text)}\n`);
}

function warn(text: string): void {
  process.stdout.write(`${tui.warn(text)}\n`);
}

function fail(message: string): never {
  throw new Error(message);
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function randomSecret(lengthBytes: number): string {
  return randomBytes(lengthBytes).toString("base64url");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

async function writeText(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
}

async function copyIfMissing(sourcePath: string, targetPath: string): Promise<void> {
  if (await fileExists(targetPath)) return;
  if (await fileExists(sourcePath)) {
    await ensureDir(path.dirname(targetPath));
    await fs.copyFile(sourcePath, targetPath);
    return;
  }
  await writeText(targetPath, "");
}

async function seedSkills(codeDir: string, stateDir: string): Promise<number> {
  const srcRoot = path.join(codeDir, "skills");

  if (!(await fileExists(srcRoot))) return 0;

  let copied = 0;

  async function walkSkillTree(root: string, destRoot: string): Promise<void> {
    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const hasSkillFile = entries.some((e) => e.isFile() && e.name === "SKILL.md");

      if (hasSkillFile) {
        const relDir = path.relative(root, dir);
        const destDir = path.join(destRoot, relDir);
        await ensureDir(destDir);
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const src = path.join(dir, entry.name);
          const dest = path.join(destDir, entry.name);
          if (!(await fileExists(dest))) {
            await fs.copyFile(src, dest);
          }
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          await copyTree(path.join(dir, entry.name), path.join(destDir, entry.name));
        }
        copied++;
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
        await walk(path.join(dir, entry.name));
      }
    }

    await walk(root);
  }

  async function copyTree(src: string, dest: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(src, { withFileTypes: true });
    } catch {
      return;
    }
    await ensureDir(dest);
    for (const entry of entries) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await copyTree(s, d);
      } else if (entry.isFile() && !(await fileExists(d))) {
        await fs.copyFile(s, d);
      }
    }
  }

  // Seed global skills: skills/ → {stateDir}/skills/
  await walkSkillTree(srcRoot, path.join(stateDir, "skills"));

  // Seed preset-scoped skills: skills/_presets/{name}/ → {stateDir}/presets/{name}/skills/
  const presetsDir = path.join(srcRoot, "_presets");
  if (await fileExists(presetsDir)) {
    const presetEntries = await fs.readdir(presetsDir, { withFileTypes: true });
    for (const entry of presetEntries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      await walkSkillTree(
        path.join(presetsDir, entry.name),
        path.join(stateDir, "presets", entry.name, "skills"),
      );
    }
  }

  return copied;
}

function upsertEnvContent(existing: string, entries: Record<string, string>): string {
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(entries)) {
    const next = `${key}=${value}`;
    const idx = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = next;
    else lines.push(next);
  }
  const cleaned = lines.filter((line, idx, arr) => !(idx === arr.length - 1 && line.trim() === ""));
  return `${cleaned.join("\n")}\n`;
}

async function upsertEnvFile(filePath: string, entries: Record<string, string>): Promise<void> {
  const current = (await fileExists(filePath)) ? await readText(filePath) : "";
  const updated = upsertEnvContent(current, entries);
  await writeText(filePath, updated);
}

async function runCommand(
  title: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  dryRun: boolean,
  options: { interactive?: boolean } = {},
): Promise<void> {
  await runCommandShared(title, command, args, {
    env,
    dryRun,
    interactive: options.interactive,
    callbacks: {
      onTitle: (t) => section(t),
      onCommand: (cmd, a) => process.stdout.write(`${tui.paint("dim", "$")} ${cmd} ${a.join(" ")}\n`),
      onStdout: (chunk) => process.stdout.write(tui.paint("assistant", chunk)),
      onStderr: (chunk) => process.stdout.write(tui.paint("error", chunk)),
      onDryRun: () => ok("dry-run: command skipped"),
    },
  });
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function renderLaunchdPlist(
  serviceLabel: string,
  scriptPath: string,
  workingDirectory: string,
  stdoutPath: string,
  stderrPath: string,
  envVars: Record<string, string>,
): string {
  const envEntries = Object.entries(envVars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(serviceLabel)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xmlEscape(scriptPath)}</string>`,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(workingDirectory)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    envEntries,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(stderrPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

async function isGitRepo(dirPath: string): Promise<boolean> {
  return fileExists(path.join(dirPath, ".git"));
}

async function askQuestion(
  rl: readline.Interface,
  label: string,
  defaultValue: string,
  nonInteractive: boolean,
): Promise<string> {
  if (nonInteractive) return defaultValue;
  const answer = await rl.question(`${tui.paint("assistant", "?")} ${label} ${tui.paint("dim", `[${defaultValue}]`)}: `);
  return answer.trim() || defaultValue;
}

async function askConfirm(
  rl: readline.Interface,
  label: string,
  defaultYes: boolean,
  nonInteractive: boolean,
): Promise<boolean> {
  if (nonInteractive) return defaultYes;
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await rl.question(`${tui.paint("assistant", "?")} ${label} ${tui.paint("dim", hint)}: `);
  const normalized = answer.trim().toLowerCase();
  if (normalized === "") return defaultYes;
  return normalized === "y" || normalized === "yes";
}

function normalizeProviderId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function toEnvVarName(input: string): string {
  const core = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return core || "CUSTOM_API_KEY";
}

async function askSecretValue(
  _rl: readline.Interface,
  label: string,
  required: boolean,
  nonInteractive: boolean,
): Promise<string> {
  if (nonInteractive) return "";
  for (;;) {
    if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
      const value = await askQuestion(_rl, `${label} (input visible)`, "", false);
      if (!value && required) {
        warn("value is required");
        continue;
      }
      return value;
    }
    process.stdout.write(`${tui.paint("assistant", "?")} ${label}: `);
    const value = await new Promise<string>((resolve, reject) => {
      const chars: string[] = [];
      const onData = (chunk: Buffer | string) => {
        const input = chunk.toString("utf8");
        for (const ch of input) {
          if (ch === "\r" || ch === "\n") {
            cleanup();
            process.stdout.write("\n");
            resolve(chars.join(""));
            return;
          }
          if (ch === "\u0003") {
            cleanup();
            process.stdout.write("\n");
            reject(new Error("secret entry canceled"));
            return;
          }
          if (ch === "\u007f" || ch === "\b") {
            chars.pop();
            continue;
          }
          chars.push(ch);
        }
      };
      const cleanup = () => {
        stdin.off("data", onData);
        stdin.setRawMode(false);
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
    });
    if (!value && required) {
      warn("value is required");
      continue;
    }
    return value;
  }
}

async function promptProviderSetup(
  rl: readline.Interface,
  preset: ProviderPreset,
  nonInteractive: boolean,
): Promise<ProviderSetup> {
  const baseUrl = await askQuestion(rl, `${preset.label} base URL`, preset.baseUrl, nonInteractive);
  const model = await askQuestion(rl, `${preset.label} default model`, preset.model, nonInteractive);
  let apiKey = "";
  if (!preset.apiKeyOptional) {
    apiKey = await askSecretValue(rl, `${preset.label} API key`, true, nonInteractive);
  } else {
    const addApiKey = await askConfirm(rl, `Set API key for ${preset.label}`, false, nonInteractive);
    if (addApiKey) {
      apiKey = await askSecretValue(rl, `${preset.label} API key`, true, nonInteractive);
    }
  }
  return {
    id: preset.id,
    label: preset.label,
    baseUrl,
    model,
    envKey: preset.envKey,
    credentialId: preset.credentialId,
    apiKey: apiKey || undefined,
    local: Boolean(preset.local),
  };
}

async function promptCustomProviderSetup(
  rl: readline.Interface,
  nonInteractive: boolean,
): Promise<ProviderSetup | null> {
  if (nonInteractive) return null;
  const rawId = await askQuestion(rl, "Custom provider id", "", false);
  const id = normalizeProviderId(rawId);
  if (!id) {
    warn("skipping custom provider (invalid id)");
    return null;
  }
  const label = await askQuestion(rl, "Custom provider label", id, false);
  const baseUrl = await askQuestion(rl, "Custom provider base URL", "https://api.example.com/v1", false);
  const model = await askQuestion(rl, "Custom provider default model", "model-id", false);
  const envKey = await askQuestion(rl, "Custom provider API env key", `${toEnvVarName(id)}_API_KEY`, false);
  const credentialId = await askQuestion(rl, "Custom provider credential id", `llm.${id}.api`, false);
  const apiKey = await askSecretValue(rl, "Custom provider API key", true, false);
  return {
    id,
    label,
    baseUrl,
    model,
    envKey: toEnvVarName(envKey),
    credentialId,
    apiKey,
    local: false,
  };
}

async function promptSecretOnboardingPlan(
  rl: readline.Interface,
  nonInteractive: boolean,
): Promise<SecretOnboardingPlan> {
  const enabled = await askConfirm(rl, "Run full secrets onboarding now", !nonInteractive, nonInteractive);
  if (!enabled) {
    return { enabled: false, providers: [], extraSecrets: [] };
  }

  section("LLM Provider Selection");
  info("Select providers to configure (comma-separated indexes).");
  PROVIDER_PRESETS.forEach((preset, idx) => {
    process.stdout.write(`  ${idx + 1}. ${preset.label} (${preset.id})\n`);
  });
  const customIndex = PROVIDER_PRESETS.length + 1;
  process.stdout.write(`  ${customIndex}. Custom provider\n`);
  const selectedRaw = await askQuestion(
    rl,
    "Provider choices",
    nonInteractive ? "1" : "1,4",
    nonInteractive,
  );

  const tokens = selectedRaw
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const selected = new Set<number>();
  let includeCustom = false;
  for (const token of tokens) {
    if (token.toLowerCase() === "custom" || token === String(customIndex)) {
      includeCustom = true;
      continue;
    }
    const parsed = Number(token);
    if (!Number.isInteger(parsed)) continue;
    if (parsed >= 1 && parsed <= PROVIDER_PRESETS.length) {
      selected.add(parsed - 1);
    }
  }

  const providers: ProviderSetup[] = [];
  for (const idx of selected) {
    const preset = PROVIDER_PRESETS[idx];
    providers.push(await promptProviderSetup(rl, preset, nonInteractive));
  }
  if (includeCustom) {
    const custom = await promptCustomProviderSetup(rl, nonInteractive);
    if (custom) providers.push(custom);
  }

  if (providers.length === 0) {
    warn("no providers selected; skipping secrets onboarding");
    return { enabled: false, providers: [], extraSecrets: [] };
  }

  const extraSecrets: SecretOnboardingEntry[] = [];
  for (const preset of EXTRA_SECRET_PRESETS) {
    const shouldSet = await askConfirm(rl, `Set ${preset.label}`, false, nonInteractive);
    if (!shouldSet) continue;
    const value = await askSecretValue(rl, preset.label, Boolean(preset.required), nonInteractive);
    if (!value) continue;
    extraSecrets.push({
      credentialId: preset.credentialId,
      label: preset.label,
      envKeys: preset.envKeys,
      value,
    });
  }

  const defaultProvider = providers.find((provider) => !provider.local)?.id ?? providers[0]?.id;
  const defaultProviderId = await askQuestion(
    rl,
    "Default LLM provider id",
    defaultProvider ?? "default",
    nonInteractive,
  );
  return {
    enabled: true,
    providers,
    extraSecrets,
    defaultProviderId,
  };
}

async function readExistingSetupSecrets(paths: SetupPaths): Promise<Partial<SetupSecrets>> {
  const existing: Partial<SetupSecrets> = {};
  const httpApiKey = await readEnvFileValue(paths.gatewayEnvFile, "NEXUS_HTTP_API_KEY");
  if (httpApiKey) existing.httpApiKey = httpApiKey;
  const dashboardPassword = await readEnvFileValue(paths.gatewayEnvFile, "NEXUS_DASHBOARD_PASSWORD");
  if (dashboardPassword) existing.dashboardPassword = dashboardPassword;
  const secretctlPassword = await readEnvFileValue(paths.sidecarEnvFile, "NEXUS_SECRETCTL_PASSWORD");
  if (secretctlPassword) existing.secretctlPassword = secretctlPassword;
  const credentialsKey = await readEnvFileValue(paths.sidecarEnvFile, "NEXUS_CREDENTIALS_KEY");
  if (credentialsKey) existing.credentialsKey = credentialsKey;
  const haApiKey = await readEnvFileValue(paths.watchdogEnvFile, "NEXUS_HA_API_KEY");
  if (haApiKey) existing.haApiKey = haApiKey;
  return existing;
}

function buildSetupSecrets(existing: Partial<SetupSecrets>, overwrite: boolean): SetupSecrets {
  if (overwrite) {
    const httpApiKey = randomSecret(24);
    return {
      httpApiKey,
      dashboardPassword: randomSecret(18),
      secretctlPassword: randomSecret(18),
      credentialsKey: randomSecret(32),
      haApiKey: httpApiKey,
    };
  }
  const httpApiKey = existing.httpApiKey || randomSecret(24);
  return {
    httpApiKey,
    dashboardPassword: existing.dashboardPassword || randomSecret(18),
    secretctlPassword: existing.secretctlPassword || randomSecret(18),
    credentialsKey: existing.credentialsKey || randomSecret(32),
    haApiKey: existing.haApiKey || existing.httpApiKey || httpApiKey,
  };
}

function buildDefaultPaths(opts: SetupWizardOptions): SetupPaths {
  const rootDir = path.resolve(expandHome(opts.root?.trim() || path.join(os.homedir(), ".nexus")));
  const codeDir = path.resolve(expandHome(opts.codeDir?.trim() || path.join(rootDir, "code")));
  const stateDir = path.join(rootDir, "state");
  const workspaceDir = path.join(rootDir, "workspace");
  const configRoot = path.join(rootDir, "config");
  const storeDir = path.join(rootDir, "secrets");
  const configPath = path.join(rootDir, "nexus.json");
  const gatewayEnvFile = path.join(configRoot, "gateway", "nexus.env");
  const sidecarEnvFile = path.join(configRoot, "sidecar", "nexus.env");
  const watchdogEnvFile = path.join(configRoot, "watchdog", "nexus.env");
  const tlsPemPath = path.join(codeDir, "infra", "haproxy", "certs", "nexus.pem");
  return {
    rootDir,
    codeDir,
    stateDir,
    workspaceDir,
    configRoot,
    storeDir,
    configPath,
    gatewayEnvFile,
    sidecarEnvFile,
    watchdogEnvFile,
    tlsPemPath,
  };
}

async function prepareState(rl: readline.Interface, opts: SetupWizardOptions): Promise<SetupState> {
  const nonInteractive = Boolean(opts.nonInteractive || opts.yes);
  const defaults = buildDefaultPaths(opts);
  const rootDir = path.resolve(expandHome(await askQuestion(rl, "Nexus home directory", defaults.rootDir, nonInteractive)));
  const codeDir = path.resolve(expandHome(await askQuestion(rl, "Code checkout directory", defaults.codeDir, nonInteractive)));
  const detectedRepoUrl = opts.repoUrl?.trim() || "";
  const repoUrl = await askQuestion(
    rl,
    "Repository URL (used only when code directory is missing)",
    detectedRepoUrl,
    nonInteractive,
  );
  const tlsSan = await askQuestion(rl, "TLS SAN hostname or IP", os.hostname(), nonInteractive);
  const enableHaDeployer = await askConfirm(
    rl,
    "Enable ha-deployer autostart service after deploy",
    true,
    nonInteractive,
  );

  const paths: SetupPaths = {
    ...defaults,
    rootDir,
    codeDir,
    tlsPemPath: path.join(codeDir, "infra", "haproxy", "certs", "nexus.pem"),
  };
  const existingSecrets = await readExistingSetupSecrets(paths);
  const existingCoreSecretsDetected = Object.keys(existingSecrets).length > 0;
  let overwriteCoreSecrets = false;
  if (existingCoreSecretsDetected) {
    overwriteCoreSecrets = await askConfirm(
      rl,
      "Existing core secrets found in split env files. Overwrite them with new generated values",
      false,
      nonInteractive,
    );
    if (!overwriteCoreSecrets) {
      info("keeping existing core secret values");
    }
  }
  const secretOnboarding = await promptSecretOnboardingPlan(rl, nonInteractive);
  const secrets = buildSetupSecrets(existingSecrets, overwriteCoreSecrets);

  return {
    repoUrl,
    tlsSan,
    enableHaDeployer,
    paths,
    secrets,
    existingCoreSecretsDetected,
    overwriteCoreSecrets,
    secretOnboarding,
  };
}

async function ensureCodeCheckout(state: SetupState, dryRun: boolean): Promise<void> {
  const codeDirExists = await fileExists(state.paths.codeDir);
  if (!codeDirExists) {
    if (!state.repoUrl) fail("code directory is missing and repo URL is empty");
    await ensureDir(path.dirname(state.paths.codeDir));
    await runCommand(
      "Clone Repository",
      "git",
      ["clone", "--depth=1", state.repoUrl, state.paths.codeDir],
      process.env,
      dryRun,
    );
    return;
  }
  const hasPackageJson = await fileExists(path.join(state.paths.codeDir, "package.json"));
  if (!hasPackageJson) {
    fail(`code directory exists but does not look like Nexus repo: ${state.paths.codeDir}`);
  }
  if (await isGitRepo(state.paths.codeDir)) {
    warn(`existing repository detected at ${state.paths.codeDir}; wizard will reuse it`);
  } else {
    warn(`directory ${state.paths.codeDir} is not a git repo; proceeding anyway`);
  }
}

async function writeSplitEnvFiles(state: SetupState): Promise<void> {
  const codeDir = state.paths.codeDir;
  await copyIfMissing(path.join(codeDir, ".env.gateway.example"), state.paths.gatewayEnvFile);
  await copyIfMissing(path.join(codeDir, ".env.sidecar.example"), state.paths.sidecarEnvFile);
  await copyIfMissing(path.join(codeDir, ".env.watchdog.example"), state.paths.watchdogEnvFile);

  await upsertEnvFile(state.paths.gatewayEnvFile, {
    NEXUS_HOME: state.paths.rootDir,
    NEXUS_CODE_DIR: state.paths.codeDir,
    NEXUS_HTTP_API_KEY: state.secrets.httpApiKey,
    NEXUS_DASHBOARD_USERNAME: "admin",
    NEXUS_DASHBOARD_PASSWORD: state.secrets.dashboardPassword,
  });
  await upsertEnvFile(state.paths.sidecarEnvFile, {
    NEXUS_SECRETCTL_USERNAME: "admin",
    NEXUS_SECRETCTL_PASSWORD: state.secrets.secretctlPassword,
    NEXUS_CREDENTIALS_KEY: state.secrets.credentialsKey,
    NEXUS_CREDENTIALS_STORE_DIR: state.paths.storeDir,
  });
  await upsertEnvFile(state.paths.watchdogEnvFile, {
    NEXUS_HOME: state.paths.rootDir,
    NEXUS_CODE_DIR: state.paths.codeDir,
    NEXUS_HA_API_KEY: state.secrets.haApiKey,
  });

  await fs.chmod(state.paths.gatewayEnvFile, 0o600);
  await fs.chmod(state.paths.sidecarEnvFile, 0o600);
  await fs.chmod(state.paths.watchdogEnvFile, 0o600);
  await fs.chmod(state.paths.storeDir, 0o700);
}

async function writeRuntimeConfig(state: SetupState): Promise<void> {
  let parsed: Record<string, unknown> = {};
  if (await fileExists(state.paths.configPath)) {
    const raw = await readText(state.paths.configPath);
    const value = JSON5.parse(raw) as unknown;
    if (typeof value === "object" && value !== null) {
      parsed = { ...(value as Record<string, unknown>) };
    }
  }
  parsed.stateDir = state.paths.stateDir;
  parsed.workspaceDir = state.paths.workspaceDir;
  parsed.codeDir = state.paths.codeDir;
  if (!parsed.runtime || typeof parsed.runtime !== "object") {
    parsed.runtime = { profile: "primary" };
  }
  await writeText(state.paths.configPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

async function initializeAgentState(state: SetupState, nonInteractive: boolean, rl: readline.Interface): Promise<void> {
  const { applyInitTelegramConfig, getInitializationStatus, InitTelegramSchema, runOnboarding, writeOnboardingFiles } =
    await import("../state/onboarding.js");
  const { IdentitySchema, UserProfileSchema } = await import("../state/personalization.js");
  const initStatus = await getInitializationStatus(state.paths.stateDir);
  if (initStatus.initialized) {
    ok("already initialized");
    return;
  }

  const paths = {
    stateDir: state.paths.stateDir,
    workspaceDir: state.paths.workspaceDir,
    codeDir: state.paths.codeDir,
  };

  if (nonInteractive) {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await writeOnboardingFiles(paths, IdentitySchema.parse({}), UserProfileSchema.parse({ timezone }), {
      overwriteExisting: false,
    });
    await applyInitTelegramConfig(state.paths.configPath, InitTelegramSchema.parse({}));
    ok("initialized with default onboarding values");
    return;
  }

  info("running first-time onboarding prompts");
  const result = await runOnboarding(state.paths.stateDir, { includeTelegram: true, rl });
  if (result.skipped) {
    fail("initialization canceled; setup cannot continue");
  }
  await writeOnboardingFiles(paths, result.identity, result.userProfile, { overwriteExisting: false });
  await applyInitTelegramConfig(state.paths.configPath, result.telegram ?? InitTelegramSchema.parse({}));
  ok("initialization completed");
}

function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function readEnvLineValue(content: string, key: string): string | undefined {
  const parsed = dotenv.parse(content);
  return parsed[key];
}

async function readEnvFileValue(filePath: string, key: string): Promise<string | undefined> {
  if (!(await fileExists(filePath))) return undefined;
  const raw = await readText(filePath);
  return readEnvLineValue(raw, key);
}

function setOrClearEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function applySecretOnboarding(
  state: SetupState,
  rl: readline.Interface,
  nonInteractive: boolean,
): Promise<void> {
  if (!state.secretOnboarding.enabled) {
    ok("skipped");
    return;
  }

  const { listCredentials, upsertCredential } = await import("../secrets/credentials.js");
  const credentialsKey = (await readEnvFileValue(state.paths.sidecarEnvFile, "NEXUS_CREDENTIALS_KEY")) || "";
  const credentialsStoreDir =
    (await readEnvFileValue(state.paths.sidecarEnvFile, "NEXUS_CREDENTIALS_STORE_DIR")) || state.paths.storeDir;
  if (!credentialsKey.trim()) {
    fail(`missing NEXUS_CREDENTIALS_KEY in ${state.paths.sidecarEnvFile}; cannot run secrets onboarding`);
  }

  const prevRole = process.env.NEXUS_SECRETS_PROCESS_ROLE;
  const prevKey = process.env.NEXUS_CREDENTIALS_KEY;
  const prevStore = process.env.NEXUS_CREDENTIALS_STORE_DIR;
  const prevRuntimeProfile = process.env.NEXUS_RUNTIME_PROFILE;

  const secretRefEntries: Array<{ envKey: string; credentialId: string }> = [];
  try {
    process.env.NEXUS_SECRETS_PROCESS_ROLE = "sidecar";
    process.env.NEXUS_CREDENTIALS_KEY = credentialsKey;
    process.env.NEXUS_CREDENTIALS_STORE_DIR = credentialsStoreDir;
    process.env.NEXUS_RUNTIME_PROFILE = "primary";
    const providerWrites = state.secretOnboarding.providers
      .filter((provider) => Boolean(provider.apiKey))
      .map((provider) => ({
        credentialId: provider.credentialId,
        label: provider.label,
        value: String(provider.apiKey),
        envKeys: [provider.envKey],
        note: `setup wizard: ${provider.label} API key`,
      }));
    const extraWrites = state.secretOnboarding.extraSecrets
      .filter((entry) => Boolean(entry.value))
      .map((entry) => ({
        credentialId: entry.credentialId,
        label: entry.label,
        value: entry.value,
        envKeys: entry.envKeys,
        note: `setup wizard: ${entry.label}`,
      }));
    const pendingWrites = [...providerWrites, ...extraWrites];
    const existingCredentials = await listCredentials(state.paths.stateDir);
    const existingIds = new Set(existingCredentials.map((item) => item.id));
    const existingPendingIds = pendingWrites
      .map((item) => item.credentialId)
      .filter((id, idx, arr) => existingIds.has(id) && arr.indexOf(id) === idx);

    let overwriteExisting = false;
    if (existingPendingIds.length > 0) {
      const preview = existingPendingIds.slice(0, 5).join(", ");
      const suffix = existingPendingIds.length > 5 ? ` (+${existingPendingIds.length - 5} more)` : "";
      overwriteExisting = await askConfirm(
        rl,
        `Existing sidecar credentials found (${preview}${suffix}). Overwrite existing credential values`,
        false,
        nonInteractive,
      );
      if (!overwriteExisting) {
        info("keeping existing sidecar credential values");
      }
    }

    for (const item of pendingWrites) {
      const shouldOverwrite = overwriteExisting || !existingIds.has(item.credentialId);
      if (shouldOverwrite) {
        await upsertCredential({
          stateDir: state.paths.stateDir,
          id: item.credentialId,
          password: item.value,
          note: item.note,
          overwrite: true,
        });
        ok(`stored credential ${item.credentialId}`);
      } else {
        info(`kept existing credential ${item.credentialId}`);
      }
      item.envKeys.forEach((envKey) => {
        secretRefEntries.push({ envKey, credentialId: item.credentialId });
      });
    }
  } finally {
    setOrClearEnv("NEXUS_SECRETS_PROCESS_ROLE", prevRole);
    setOrClearEnv("NEXUS_CREDENTIALS_KEY", prevKey);
    setOrClearEnv("NEXUS_CREDENTIALS_STORE_DIR", prevStore);
    setOrClearEnv("NEXUS_RUNTIME_PROFILE", prevRuntimeProfile);
  }

  const configRaw = await readText(state.paths.configPath);
  const parsed = JSON5.parse(configRaw) as Record<string, unknown>;
  const llm = ensureObject(parsed, "llm");
  const providers = ensureObject(llm, "providers");
  const routing = ensureObject(llm, "routing");
  const defaultRoute = ensureObject(routing, "default");
  const primary = ensureObject(defaultRoute, "primary");
  const secrets = ensureObject(parsed, "secrets");
  const envRefs = ensureObject(secrets, "env");

  const gatewayEnvUpdates: Record<string, string> = {};
  for (const provider of state.secretOnboarding.providers) {
    if (provider.local) {
      const localProvider = ensureObject(providers, "local");
      localProvider.baseUrl = "${NEXUS_LOCAL_LLM_BASE_URL}";
      localProvider.model = "${NEXUS_LOCAL_LLM_MODEL}";
      if (provider.apiKey) {
        localProvider.apiKey = "${NEXUS_LOCAL_LLM_API_KEY}";
      }
      gatewayEnvUpdates.NEXUS_LOCAL_LLM_BASE_URL = provider.baseUrl;
      gatewayEnvUpdates.NEXUS_LOCAL_LLM_MODEL = provider.model;
      continue;
    }
    const providerConfig: Record<string, unknown> = {
      baseUrl: provider.baseUrl,
      apiKey: `\${${provider.envKey}}`,
      model: provider.model,
    };
    if (provider.id === "fireworks") {
      providerConfig.stripCacheControl = true;
    }
    providers[provider.id] = providerConfig;
  }

  for (const item of secretRefEntries) {
    envRefs[item.envKey] = `{{secret:sidecar-main/${item.credentialId}#password}}`;
  }

  const selectedProviderIds = new Set(state.secretOnboarding.providers.map((provider) => provider.id));
  const defaultProviderId = normalizeProviderId(state.secretOnboarding.defaultProviderId ?? "");
  if (defaultProviderId && selectedProviderIds.has(defaultProviderId)) {
    primary.provider = defaultProviderId;
    const provider = state.secretOnboarding.providers.find((entry) => entry.id === defaultProviderId);
    if (provider?.model) {
      primary.model = provider.model;
    }
    if (defaultProviderId !== "local") {
      const fallback = ensureObject(defaultRoute, "fallback");
      fallback.provider = "local";
    } else {
      delete defaultRoute.fallback;
    }
  } else if (defaultProviderId) {
    warn(`default provider '${defaultProviderId}' was not selected; keeping existing routing.default`);
  }

  await writeText(state.paths.configPath, `${JSON.stringify(parsed, null, 2)}\n`);
  if (Object.keys(gatewayEnvUpdates).length > 0) {
    await upsertEnvFile(state.paths.gatewayEnvFile, gatewayEnvUpdates);
  }
  ok("secret onboarding config updated");
}

function buildScriptEnv(state: SetupState): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NEXUS_HOME: state.paths.rootDir,
    NEXUS_CODE_DIR: state.paths.codeDir,
    NEXUS_STATE_DIR: state.paths.stateDir,
    NEXUS_WORKSPACE_DIR: state.paths.workspaceDir,
    NEXUS_HOST_CODE_DIR: state.paths.codeDir,
    NEXUS_HOST_STATE_DIR: state.paths.stateDir,
    NEXUS_HOST_WORKSPACE_DIR: state.paths.workspaceDir,
    NEXUS_HOST_SECRETS_DIR: state.paths.storeDir,
    CODE_DIR: state.paths.codeDir,
    CONFIG_ROOT: state.paths.configRoot,
    STATE_DIR: state.paths.stateDir,
    STORE_DIR: state.paths.storeDir,
    NEXUS_GATEWAY_ENV_FILE: state.paths.gatewayEnvFile,
    NEXUS_SIDECAR_ENV_FILE: state.paths.sidecarEnvFile,
    NEXUS_WATCHDOG_ENV_FILE: state.paths.watchdogEnvFile,
    NEXUS_HAPROXY_TLS_CERT_PEM: state.paths.tlsPemPath,
  };
}

async function installHaDeployerSystemd(state: SetupState, env: NodeJS.ProcessEnv, dryRun: boolean): Promise<void> {
  const serviceOverridePath = path.join(state.paths.rootDir, "ha-deployer.override.conf");
  const serviceOverride = [
    "[Service]",
    `Environment=NEXUS_HOME=${state.paths.rootDir}`,
    `Environment=NEXUS_CODE_DIR=${state.paths.codeDir}`,
    `Environment=STATE_DIR=${state.paths.stateDir}`,
    `EnvironmentFile=-${state.paths.watchdogEnvFile}`,
    `EnvironmentFile=-${state.paths.gatewayEnvFile}`,
    "",
  ].join("\n");
  if (!dryRun) {
    await writeText(serviceOverridePath, serviceOverride);
  }

  info("sudo access is required to install and enable ha-deployer");

  await runCommand(
    "Enable ha-deployer Service",
    "sudo",
    [
      "cp",
      path.join(state.paths.codeDir, "infra", "systemd", "ha-deployer.service"),
      "/etc/systemd/system/ha-deployer.service",
    ],
    env,
    dryRun,
    { interactive: true },
  );
  await runCommand(
    "Install ha-deployer Override",
    "sudo",
    ["mkdir", "-p", "/etc/systemd/system/ha-deployer.service.d"],
    env,
    dryRun,
    { interactive: true },
  );
  await runCommand(
    "Copy ha-deployer Override",
    "sudo",
    ["cp", serviceOverridePath, "/etc/systemd/system/ha-deployer.service.d/nexus-paths.conf"],
    env,
    dryRun,
    { interactive: true },
  );
  await runCommand("Reload systemd", "sudo", ["systemctl", "daemon-reload"], env, dryRun, { interactive: true });
  await runCommand("Start ha-deployer", "sudo", ["systemctl", "enable", "--now", "ha-deployer"], env, dryRun, {
    interactive: true,
  });
}

async function installHaDeployerLaunchd(state: SetupState, env: NodeJS.ProcessEnv, dryRun: boolean): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid < 0) {
    fail("unable to determine user id for launchd setup");
  }

  const serviceLabel = "io.outerreaches.nexus.ha-deployer";
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, `${serviceLabel}.plist`);
  const logDir = path.join(state.paths.rootDir, "logs");
  const stdoutPath = path.join(logDir, "ha-deployer.out.log");
  const stderrPath = path.join(logDir, "ha-deployer.err.log");
  const scriptPath = path.join(state.paths.codeDir, "infra", "scripts", "ha-deployer.sh");

  const plist = renderLaunchdPlist(serviceLabel, scriptPath, state.paths.codeDir, stdoutPath, stderrPath, {
    NEXUS_HOME: state.paths.rootDir,
    NEXUS_CODE_DIR: state.paths.codeDir,
    NEXUS_STATE_DIR: state.paths.stateDir,
    NEXUS_WORKSPACE_DIR: state.paths.workspaceDir,
    CODE_DIR: state.paths.codeDir,
    CONFIG_ROOT: state.paths.configRoot,
    STATE_DIR: state.paths.stateDir,
    STORE_DIR: state.paths.storeDir,
    NEXUS_GATEWAY_ENV_FILE: state.paths.gatewayEnvFile,
    NEXUS_SIDECAR_ENV_FILE: state.paths.sidecarEnvFile,
    NEXUS_WATCHDOG_ENV_FILE: state.paths.watchdogEnvFile,
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  });

  section("Enable ha-deployer Service");
  if (dryRun) {
    ok(`dry-run: would write launchd plist to ${plistPath}`);
  } else {
    await ensureDir(launchAgentsDir);
    await ensureDir(logDir);
    await writeText(plistPath, plist);
    ok(`launchd plist written: ${plistPath}`);
  }

  const domains = [`gui/${uid}`, `user/${uid}`];
  let started = false;
  for (const domain of domains) {
    try {
      await runCommand(`Unload ha-deployer (${domain})`, "launchctl", ["bootout", domain, plistPath], env, dryRun);
    } catch {
      warn(`ha-deployer not currently loaded in ${domain}; continuing`);
    }
    try {
      await runCommand(`Load ha-deployer (${domain})`, "launchctl", ["bootstrap", domain, plistPath], env, dryRun);
      await runCommand(`Enable ha-deployer (${domain})`, "launchctl", ["enable", `${domain}/${serviceLabel}`], env, dryRun);
      await runCommand(`Start ha-deployer (${domain})`, "launchctl", ["kickstart", "-k", `${domain}/${serviceLabel}`], env, dryRun);
      started = true;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`launchd bootstrap failed in ${domain}: ${message}`);
    }
  }

  if (!started) {
    fail("unable to start ha-deployer with launchd; check launchctl output");
  }
}

async function installHaDeployerService(state: SetupState, env: NodeJS.ProcessEnv, dryRun: boolean): Promise<void> {
  if (process.platform === "linux") {
    await installHaDeployerSystemd(state, env, dryRun);
    return;
  }
  if (process.platform === "darwin") {
    await installHaDeployerLaunchd(state, env, dryRun);
    return;
  }
  warn(`ha-deployer autostart is not implemented for platform '${process.platform}'`);
}

function printSummary(state: SetupState): void {
  const lines: string[] = [
    tui.checkbox("Enable ha-deployer autostart", state.enableHaDeployer),
    tui.checkbox("Run full secret onboarding", state.secretOnboarding.enabled),
  ];
  if (state.existingCoreSecretsDetected) {
    lines.push(tui.checkbox("Overwrite existing core split-env secrets", state.overwriteCoreSecrets));
  } else {
    lines.push(tui.checkbox("Generate core split-env secrets", true));
  }
  lines.push("");
  lines.push(`rootDir      : ${state.paths.rootDir}`);
  lines.push(`codeDir      : ${state.paths.codeDir}`);
  lines.push(`stateDir     : ${state.paths.stateDir}`);
  lines.push(`workspaceDir : ${state.paths.workspaceDir}`);
  lines.push(`configPath   : ${state.paths.configPath}`);
  lines.push(`configRoot   : ${state.paths.configRoot}`);
  lines.push(`storeDir     : ${state.paths.storeDir}`);
  lines.push(`tlsPemPath   : ${state.paths.tlsPemPath}`);

  if (state.secretOnboarding.enabled) {
    lines.push("");
    lines.push("Selected providers:");
    for (const provider of state.secretOnboarding.providers) {
      lines.push(`- ${provider.id} (${provider.model})`);
    }
    lines.push(`extra-secrets: ${state.secretOnboarding.extraSecrets.length}`);
    if (state.secretOnboarding.defaultProviderId) {
      lines.push(`default-provider: ${state.secretOnboarding.defaultProviderId}`);
    }
  }
  process.stdout.write(`${tui.panel("Setup Summary", lines, { borderRole: "prompt", titleRole: "system" })}\n`);
  process.stdout.write("\n");
}

async function applySetup(state: SetupState, opts: SetupWizardOptions, rl: readline.Interface): Promise<void> {
  const dryRun = Boolean(opts.dryRun);
  const nonInteractive = Boolean(opts.nonInteractive || opts.yes);
  const completedPhases: string[] = [];

  try {
    section("Prepare Directories");
    await ensureDir(state.paths.rootDir);
    await ensureDir(state.paths.stateDir);
    await ensureDir(state.paths.workspaceDir);
    await ensureDir(state.paths.configRoot);
    await ensureDir(path.join(state.paths.configRoot, "gateway"));
    await ensureDir(path.join(state.paths.configRoot, "sidecar"));
    await ensureDir(path.join(state.paths.configRoot, "watchdog"));
    await ensureDir(state.paths.storeDir);
    ok("directory layout prepared");
    completedPhases.push("Prepare Directories");

    section("Seed Skills");
    const seededCount = await seedSkills(state.paths.codeDir, state.paths.stateDir);
    ok(seededCount > 0 ? `seeded ${seededCount} skill(s) from repo` : "no skills to seed (or all already present)");
    completedPhases.push("Seed Skills");

    section("Write Config + Env");
    if (!dryRun) {
      await writeSplitEnvFiles(state);
      await writeRuntimeConfig(state);
    }
    ok(dryRun ? "dry-run: skipped file writes" : "config and split env files written");
    completedPhases.push("Write Config + Env");

    section("Initialize Agent State");
    if (dryRun) {
      ok("dry-run: skipped initialization");
    } else {
      await initializeAgentState(state, nonInteractive, rl);
    }
    completedPhases.push("Initialize Agent State");

    section("Secrets Onboarding");
    if (dryRun) {
      if (state.secretOnboarding.enabled) {
        info(
          `dry-run: would onboard providers ${state.secretOnboarding.providers.map((provider) => provider.id).join(", ")}`,
        );
      }
      ok("dry-run: skipped secret onboarding");
    } else {
      await applySecretOnboarding(state, rl, nonInteractive);
    }
    completedPhases.push("Secrets Onboarding");

    const env = buildScriptEnv(state);
    const tlsScript = path.join(state.paths.codeDir, "infra", "scripts", "setup", "ha-generate-tls-cert.sh");
    const preflightScript = path.join(state.paths.codeDir, "infra", "scripts", "setup", "ha-secrets-preflight.sh");
    const deployScript = path.join(state.paths.codeDir, "infra", "scripts", "pull-deploy.sh");
    const rolloutScript = path.join(state.paths.codeDir, "infra", "scripts", "ha-rollout.sh");

    await runCommand(
      "Generate TLS Certificate",
      "bash",
      [tlsScript, "--san", state.tlsSan, "--san", "localhost"],
      env,
      dryRun,
    );
    completedPhases.push("Generate TLS Certificate");

    await runCommand(
      "Secrets Preflight",
      "bash",
      [preflightScript, "--auto-fix", "--require-http-api-key"],
      env,
      dryRun,
    );
    completedPhases.push("Secrets Preflight");

    await runCommand("Deploy Stack", "bash", [deployScript], env, dryRun);
    completedPhases.push("Deploy Stack");

    await runCommand("HA Status", "bash", [rolloutScript, "status"], env, dryRun);
    completedPhases.push("HA Status");

    if (state.enableHaDeployer) {
      await installHaDeployerService(state, env, dryRun);
      completedPhases.push("Install ha-deployer Service");
    }
  } catch (err) {
    process.stdout.write("\n");
    warn(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
    if (completedPhases.length > 0) {
      warn("The following phases completed before the failure:");
      for (const phase of completedPhases) {
        process.stdout.write(`  - ${phase}\n`);
      }
    }
    warn("Partial state may have been written. Re-running setup is safe (files are upserted, not overwritten destructively).");
    info("Fix the issue above and re-run: nexus setup");
    throw err;
  }
}

export async function runSetupWizard(opts: SetupWizardOptions): Promise<void> {
  const nonInteractive = Boolean(opts.nonInteractive || opts.yes);
  if (!nonInteractive && (!stdin.isTTY || !stdout.isTTY)) {
    fail("setup wizard requires a TTY");
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    banner("Nexus Setup Wizard", "Classic Green Edition");
    process.stdout.write(`${tui.paint("dim", "This wizard sets up a new Nexus instance under ~/.nexus by default.")}\n\n`);

    const state = await prepareState(rl, opts);
    printSummary(state);
    const proceed = await askConfirm(
      rl,
      opts.dryRun ? "Run setup in dry-run mode now" : "Proceed with setup now",
      true,
      Boolean(opts.nonInteractive || opts.yes),
    );
    if (!proceed) {
      warn("setup canceled by user");
      return;
    }

    await ensureCodeCheckout(state, Boolean(opts.dryRun));
    await applySetup(state, opts, rl);

    process.stdout.write("\n");
    ok("setup wizard complete");
    info(`Dashboard/API key stored in: ${state.paths.gatewayEnvFile}`);
    info(`Sidecar secrets config stored in: ${state.paths.sidecarEnvFile}`);
    info(`Watchdog HA config stored in: ${state.paths.watchdogEnvFile}`);
  } finally {
    rl.close();
  }
}
