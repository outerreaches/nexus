import fs from "node:fs/promises";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import JSON5 from "json5";
import { z } from "zod";

import {
  type Identity,
  type PersonalizationTemplatePaths,
  type UserProfile,
  IdentitySchema,
  UserProfileSchema,
  PERSONALIZATION_FILES,
  SOUL_FILENAME,
  AGENTS_FILENAME,
  USER_FILENAME,
  CODEGUIDE_FILENAME,
  MEMORY_FILENAME,
  HEARTBEAT_FILENAME,
  NOTES_FILENAME,
  getDefaultSoulTemplate,
  getDefaultAgentsTemplate,
  getDefaultUserTemplate,
  getDefaultCodeguideTemplate,
  getDefaultMemoryTemplate,
  getDefaultHeartbeatTemplate,
  getDefaultNotesTemplate,
  readPersonalizationFile,
  writePersonalizationFile,
} from "./personalization.js";

export type OnboardingResult = {
  identity: Identity;
  userProfile: UserProfile;
  skipped: boolean;
  telegram?: InitTelegramSettings;
};

// Simple ANSI formatting (no external deps)
const fmt = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const InitTelegramPairingSchema = z
  .object({
    enabled: z.boolean().default(true),
    codeTtlMs: z.number().int().positive().default(60 * 60 * 1000),
    maxPending: z.number().int().positive().default(3),
  })
  .default({});

export const InitTelegramSchema = z
  .object({
    enabled: z.boolean().default(false),
    allowFrom: z.array(z.number().int()).default([]),
    pairing: InitTelegramPairingSchema,
  })
  .default({});

export type InitTelegramSettings = z.infer<typeof InitTelegramSchema>;

const InitOnboardingFileSchema = z.object({
  identity: IdentitySchema.partial().default({}),
  userProfile: UserProfileSchema.partial().default({}),
  telegram: InitTelegramSchema.default({}),
});

export type InitOnboardingValues = {
  identity: Identity;
  userProfile: UserProfile;
  telegram: InitTelegramSettings;
};

export type InitializationStatus = {
  initialized: boolean;
  missingFiles: string[];
};

async function prompt(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` ${fmt.dim(`[${defaultValue}]`)}` : "";
  const answer = await rl.question(`${question}${suffix}: `);
  return answer.trim() || defaultValue || "";
}

async function confirm(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await rl.question(`${question} ${fmt.dim(hint)}: `);
  const normalized = answer.trim().toLowerCase();
  if (normalized === "") return defaultYes;
  return normalized === "y" || normalized === "yes";
}

async function promptInt(
  rl: readline.Interface,
  question: string,
  defaultValue: number,
  opts: { min?: number; max?: number } = {},
): Promise<number> {
  for (;;) {
    const raw = await prompt(rl, question, String(defaultValue));
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      console.log(fmt.dim("Please enter a whole number."));
      continue;
    }
    if (opts.min !== undefined && parsed < opts.min) {
      console.log(fmt.dim(`Value must be >= ${opts.min}.`));
      continue;
    }
    if (opts.max !== undefined && parsed > opts.max) {
      console.log(fmt.dim(`Value must be <= ${opts.max}.`));
      continue;
    }
    return parsed;
  }
}

async function promptGender(rl: readline.Interface, defaultMale: boolean = true): Promise<boolean> {
  const defaultValue = defaultMale ? "male" : "female";
  for (;;) {
    const raw = await prompt(rl, "  Male or female?", defaultValue);
    const normalized = raw.trim().toLowerCase();
    if (["male", "m", "man", "boy"].includes(normalized)) return true;
    if (["female", "f", "woman", "girl"].includes(normalized)) return false;
    console.log(fmt.dim("Please enter 'male' or 'female'."));
  }
}

async function promptAllowFrom(rl: readline.Interface): Promise<number[]> {
  for (;;) {
    const raw = await prompt(rl, "  Allowlist user IDs (comma-separated, optional)", "");
    if (!raw) return [];
    const parts = raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const ids = parts.map((part) => Number(part));
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      console.log(fmt.dim("Each user id must be a positive integer."));
      continue;
    }
    return Array.from(new Set(ids));
  }
}

function getDefaultInitTelegramSettings(): InitTelegramSettings {
  return InitTelegramSchema.parse({});
}

export async function runOnboarding(
  stateDir: string,
  options: { includeTelegram?: boolean; rl?: readline.Interface } = {},
): Promise<OnboardingResult> {
  const includeTelegram = options.includeTelegram ?? false;
  const ownsRl = !options.rl;
  const rl = options.rl ?? readline.createInterface({ input: stdin, output: stdout });

  try {
    console.log();
    console.log(fmt.bold(fmt.cyan("╭─────────────────────────────────────────╮")));
    console.log(fmt.bold(fmt.cyan("│")) + fmt.bold("   Welcome to Nexus — First-Time Setup   ") + fmt.bold(fmt.cyan("│")));
    console.log(fmt.bold(fmt.cyan("╰─────────────────────────────────────────╯")));
    console.log();
    console.log(fmt.dim("Let's personalize your agent. You can always edit these files later."));
    console.log(fmt.dim(`Files will be created in: ${stateDir}`));
    console.log();

    // ─────────────────────────────────────────────────────────────────────────
    // Agent Identity
    // ─────────────────────────────────────────────────────────────────────────
    console.log(fmt.bold(fmt.yellow("▸ Agent Identity")));

    const agentName = await prompt(rl, "  Agent name", "Nexus");
    const agentEmoji = await prompt(rl, "  Agent emoji", "🔮");
    const agentVibe = await prompt(rl, "  Agent vibe/personality", "Helpful, competent, direct");

    const identity = IdentitySchema.parse({
      name: agentName,
      emoji: agentEmoji,
      vibe: agentVibe,
    });

    console.log();

    // ─────────────────────────────────────────────────────────────────────────
    // User Profile
    // ─────────────────────────────────────────────────────────────────────────
    console.log(fmt.bold(fmt.yellow("▸ Your Profile")));

    const userName = await prompt(rl, "  Your name (optional)", "");
    const userGender = await promptGender(rl, true);
    const userTimezone = await prompt(rl, "  Your timezone", Intl.DateTimeFormat().resolvedOptions().timeZone);
    const userContext = await prompt(rl, "  Anything the agent should know about you? (optional)", "");

    const userProfile = UserProfileSchema.parse({
      name: userName || undefined,
      gender: userGender,
      timezone: userTimezone,
      context: userContext || undefined,
    });

    let telegram = getDefaultInitTelegramSettings();
    if (includeTelegram) {
      console.log();
      console.log(fmt.bold(fmt.yellow("▸ Telegram Setup")));
      const enabled = await confirm(rl, "  Enable Telegram channel?", false);
      if (enabled) {
        const allowFrom = await promptAllowFrom(rl);
        const pairingEnabled = await confirm(rl, "  Enable pairing for unknown users?", true);
        const codeTtlMinutes = pairingEnabled
          ? await promptInt(rl, "  Pairing code TTL (minutes)", 60, { min: 1, max: 24 * 60 })
          : 60;
        const maxPending = pairingEnabled
          ? await promptInt(rl, "  Max pending pairing codes", 3, { min: 1, max: 20 })
          : 3;
        telegram = InitTelegramSchema.parse({
          enabled: true,
          allowFrom,
          pairing: {
            enabled: pairingEnabled,
            codeTtlMs: codeTtlMinutes * 60_000,
            maxPending,
          },
        });
      } else {
        telegram = InitTelegramSchema.parse({
          enabled: false,
          allowFrom: [],
          pairing: {
            enabled: false,
            codeTtlMs: 60 * 60 * 1000,
            maxPending: 3,
          },
        });
      }
    }

    console.log();

    // ─────────────────────────────────────────────────────────────────────────
    // Confirmation
    // ─────────────────────────────────────────────────────────────────────────
    console.log(fmt.bold(fmt.yellow("▸ Summary")));
    console.log(`  Agent: ${identity.emoji} ${identity.name} — "${identity.vibe}"`);
    if (userProfile.name) {
      console.log(`  User: ${userProfile.name} (${userProfile.timezone})`);
    } else {
      console.log(`  User: (anonymous) (${userProfile.timezone})`);
    }
    if (includeTelegram) {
      const ttlMinutes = Math.max(1, Math.floor(telegram.pairing.codeTtlMs / 60_000));
      console.log(
        `  Telegram: enabled=${telegram.enabled}, allowFrom=${telegram.allowFrom.length}, pairing=${telegram.pairing.enabled}, ttl=${ttlMinutes}m, maxPending=${telegram.pairing.maxPending}`,
      );
    }
    console.log();

    const proceed = await confirm(rl, "Create personalization files?", true);
    if (!proceed) {
      console.log(fmt.dim("Skipped. Run `nexus init --force` later."));
      return { identity, userProfile, skipped: true, telegram: includeTelegram ? telegram : undefined };
    }

    return { identity, userProfile, skipped: false, telegram: includeTelegram ? telegram : undefined };
  } finally {
    if (ownsRl) rl.close();
  }
}

export async function writeOnboardingFiles(
  paths: PersonalizationTemplatePaths,
  identity: Identity,
  userProfile: UserProfile,
  options: { overwriteExisting?: boolean } = {},
): Promise<void> {
  const stateDir = paths.stateDir;
  const overwriteExisting = options.overwriteExisting ?? true;
  let written = 0;
  let kept = 0;

  const writeOrKeep = async (filename: string, content: string) => {
    if (!overwriteExisting) {
      const existing = await readPersonalizationFile(stateDir, filename);
      if (existing && existing.trim().length > 0) {
        kept += 1;
        console.log(`  ${fmt.dim("-")} ${filename} (kept existing)`);
        return;
      }
    }
    await writePersonalizationFile(stateDir, filename, content);
    written += 1;
    console.log(`  ${fmt.green("✓")} ${filename}`);
  };

  console.log();
  console.log(fmt.dim("Creating personalization files..."));

  await writeOrKeep(SOUL_FILENAME, getDefaultSoulTemplate(identity));
  await writeOrKeep(AGENTS_FILENAME, getDefaultAgentsTemplate());
  await writeOrKeep(USER_FILENAME, getDefaultUserTemplate(userProfile));
  await writeOrKeep(CODEGUIDE_FILENAME, getDefaultCodeguideTemplate(paths));
  await writeOrKeep(MEMORY_FILENAME, getDefaultMemoryTemplate());
  await writeOrKeep(HEARTBEAT_FILENAME, getDefaultHeartbeatTemplate(paths.stateDir));
  await writeOrKeep(NOTES_FILENAME, getDefaultNotesTemplate());

  console.log();
  console.log(fmt.bold(fmt.green("✓ Onboarding complete!")));
  if (!overwriteExisting && kept > 0) {
    console.log(fmt.dim(`  Preserved ${kept} existing file(s); wrote ${written} file(s).`));
  }
  console.log(fmt.dim(`  Edit files in ${stateDir} to customize further.`));
  console.log();
}

function toInitOnboardingValues(input: z.infer<typeof InitOnboardingFileSchema>): InitOnboardingValues {
  return {
    identity: IdentitySchema.parse(input.identity ?? {}),
    userProfile: UserProfileSchema.parse(input.userProfile ?? {}),
    telegram: InitTelegramSchema.parse(input.telegram ?? {}),
  };
}

export async function loadInitOnboardingValuesFromFile(filePath: string): Promise<InitOnboardingValues> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    throw new Error(`Unable to read onboarding JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid onboarding JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const normalized = InitOnboardingFileSchema.parse(parsed);
  return toInitOnboardingValues(normalized);
}

export async function applyInitTelegramConfig(configPath: string, telegram: InitTelegramSettings): Promise<void> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON5.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid config structure in ${configPath}`);
  }

  const channels =
    parsed.channels && typeof parsed.channels === "object"
      ? (parsed.channels as Record<string, unknown>)
      : ((parsed.channels = {}) as Record<string, unknown>);
  const telegramConfig =
    channels.telegram && typeof channels.telegram === "object"
      ? (channels.telegram as Record<string, unknown>)
      : ((channels.telegram = {}) as Record<string, unknown>);

  telegramConfig.enabled = telegram.enabled;
  if (!telegramConfig.token) {
    telegramConfig.token = "${TELEGRAM_BOT_TOKEN}";
  }
  if (typeof telegramConfig.mode !== "string") {
    telegramConfig.mode = "polling";
  }
  if (typeof telegramConfig.requireMentionInGroups !== "boolean") {
    telegramConfig.requireMentionInGroups = true;
  }
  if (typeof telegramConfig.agentId !== "string") {
    telegramConfig.agentId = "main";
  }
  telegramConfig.allowFrom = telegram.allowFrom;

  const pairing =
    telegramConfig.pairing && typeof telegramConfig.pairing === "object"
      ? (telegramConfig.pairing as Record<string, unknown>)
      : ((telegramConfig.pairing = {}) as Record<string, unknown>);
  pairing.enabled = telegram.pairing.enabled;
  pairing.codeTtlMs = telegram.pairing.codeTtlMs;
  pairing.maxPending = telegram.pairing.maxPending;

  await fs.writeFile(configPath, JSON5.stringify(parsed, null, 2) + "\n", "utf8");
}

export async function getInitializationStatus(stateDir: string): Promise<InitializationStatus> {
  const missingFiles: string[] = [];
  for (const filename of PERSONALIZATION_FILES) {
    const content = await readPersonalizationFile(stateDir, filename);
    if (!content || content.trim().length === 0) {
      missingFiles.push(filename);
    }
  }
  return {
    initialized: missingFiles.length === 0,
    missingFiles,
  };
}

export function getInitializationErrorMessage(status: InitializationStatus): string {
  if (status.initialized) return "Nexus is initialized.";
  const missingSuffix =
    status.missingFiles.length > 0 ? ` Missing files: ${status.missingFiles.join(", ")}.` : "";
  return (
    `Nexus is not initialized.${missingSuffix} ` +
    "Run `npm run dev -- init` (interactive) or `npm run dev -- init --onboarding-json <path>`."
  );
}
