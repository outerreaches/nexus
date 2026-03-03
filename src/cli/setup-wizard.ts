import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import JSON5 from "json5";

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
};

const theme = {
  reset: "\x1b[0m",
  brightGreen: "\x1b[92m",
  green: "\x1b[32m",
  dimGreen: "\x1b[32;2m",
  blackOnGreen: "\x1b[30;42m",
};

function paint(code: string, text: string): string {
  return `${code}${text}${theme.reset}`;
}

function green(text: string): string {
  return paint(theme.green, text);
}

function brightGreen(text: string): string {
  return paint(theme.brightGreen, text);
}

function dimGreen(text: string): string {
  return paint(theme.dimGreen, text);
}

function banner(title: string, subtitle: string): void {
  const line = "+------------------------------------------------------------+";
  process.stdout.write(`${brightGreen(line)}\n`);
  process.stdout.write(`${brightGreen(`| ${title.padEnd(58, " ")}|`)}\n`);
  process.stdout.write(`${brightGreen(`| ${subtitle.padEnd(58, " ")}|`)}\n`);
  process.stdout.write(`${brightGreen(line)}\n\n`);
}

function section(title: string): void {
  process.stdout.write(`${paint(theme.blackOnGreen, ` ${title} `)}\n`);
}

function info(text: string): void {
  process.stdout.write(`${green("->")} ${text}\n`);
}

function ok(text: string): void {
  process.stdout.write(`${brightGreen("[ok]")} ${text}\n`);
}

function warn(text: string): void {
  process.stdout.write(`${green("[warn]")} ${text}\n`);
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
): Promise<void> {
  section(title);
  process.stdout.write(`${dimGreen("$")} ${command} ${args.join(" ")}\n`);
  if (dryRun) {
    ok("dry-run: command skipped");
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      process.stdout.write(green(chunk));
    });
    child.stderr.on("data", (chunk: string) => {
      process.stdout.write(brightGreen(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`command failed (${command}), exit=${code ?? "unknown"}`));
    });
  });
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
  const answer = await rl.question(`${green("?")} ${label} ${dimGreen(`[${defaultValue}]`)}: `);
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
  const answer = await rl.question(`${green("?")} ${label} ${dimGreen(hint)}: `);
  const normalized = answer.trim().toLowerCase();
  if (normalized === "") return defaultYes;
  return normalized === "y" || normalized === "yes";
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
    "Enable ha-deployer systemd service after deploy",
    true,
    nonInteractive,
  );

  const paths: SetupPaths = {
    ...defaults,
    rootDir,
    codeDir,
    tlsPemPath: path.join(codeDir, "infra", "haproxy", "certs", "nexus.pem"),
  };

  const httpApiKey = randomSecret(24);
  const dashboardPassword = randomSecret(18);
  const secretctlPassword = randomSecret(18);
  const credentialsKey = randomSecret(32);
  const haApiKey = httpApiKey;

  const secrets: SetupSecrets = {
    httpApiKey,
    dashboardPassword,
    secretctlPassword,
    credentialsKey,
    haApiKey,
  };

  return {
    repoUrl,
    tlsSan,
    enableHaDeployer,
    paths,
    secrets,
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

function printSummary(state: SetupState): void {
  section("Setup Summary");
  info(`rootDir: ${state.paths.rootDir}`);
  info(`codeDir: ${state.paths.codeDir}`);
  info(`stateDir: ${state.paths.stateDir}`);
  info(`workspaceDir: ${state.paths.workspaceDir}`);
  info(`configPath: ${state.paths.configPath}`);
  info(`configRoot: ${state.paths.configRoot}`);
  info(`storeDir: ${state.paths.storeDir}`);
  info(`tlsPemPath: ${state.paths.tlsPemPath}`);
  info(`ha-deployer: ${state.enableHaDeployer ? "enable" : "skip"}`);
  process.stdout.write("\n");
}

async function applySetup(state: SetupState, opts: SetupWizardOptions): Promise<void> {
  const dryRun = Boolean(opts.dryRun);

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

  section("Write Config + Env");
  if (!dryRun) {
    await writeSplitEnvFiles(state);
    await writeRuntimeConfig(state);
  }
  ok(dryRun ? "dry-run: skipped file writes" : "config and split env files written");

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

  await runCommand(
    "Secrets Preflight",
    "bash",
    [preflightScript, "--auto-fix", "--require-http-api-key"],
    env,
    dryRun,
  );

  await runCommand("Deploy Stack", "bash", [deployScript], env, dryRun);
  await runCommand("HA Status", "bash", [rolloutScript, "status"], env, dryRun);

  if (state.enableHaDeployer) {
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
    );
    await runCommand(
      "Install ha-deployer Override",
      "sudo",
      ["mkdir", "-p", "/etc/systemd/system/ha-deployer.service.d"],
      env,
      dryRun,
    );
    await runCommand(
      "Copy ha-deployer Override",
      "sudo",
      ["cp", serviceOverridePath, "/etc/systemd/system/ha-deployer.service.d/nexus-paths.conf"],
      env,
      dryRun,
    );
    await runCommand("Reload systemd", "sudo", ["systemctl", "daemon-reload"], env, dryRun);
    await runCommand("Start ha-deployer", "sudo", ["systemctl", "enable", "--now", "ha-deployer"], env, dryRun);
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
    process.stdout.write(`${dimGreen("This wizard sets up a new Nexus instance under ~/.nexus by default.")}\n\n`);

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
    await applySetup(state, opts);

    process.stdout.write("\n");
    ok("setup wizard complete");
    info(`Dashboard/API key stored in: ${state.paths.gatewayEnvFile}`);
    info(`Sidecar secrets config stored in: ${state.paths.sidecarEnvFile}`);
    info(`Watchdog HA config stored in: ${state.paths.watchdogEnvFile}`);
  } finally {
    rl.close();
  }
}
