import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import {
  type Identity,
  type UserProfile,
  IdentitySchema,
  UserProfileSchema,
  SOUL_FILENAME,
  AGENTS_FILENAME,
  IDENTITY_FILENAME,
  USER_FILENAME,
  TOOLS_FILENAME,
  HEARTBEAT_FILENAME,
  NOTES_FILENAME,
  getDefaultSoulTemplate,
  getDefaultAgentsTemplate,
  getDefaultIdentityTemplate,
  getDefaultUserTemplate,
  getDefaultToolsTemplate,
  getDefaultHeartbeatTemplate,
  getDefaultNotesTemplate,
  personalizationFileExists,
  writePersonalizationFile,
} from "./personalization.js";

export type OnboardingResult = {
  identity: Identity;
  userProfile: UserProfile;
  skipped: boolean;
};

// Simple ANSI formatting (no external deps)
const fmt = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
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

export async function runOnboarding(workspaceDir: string): Promise<OnboardingResult> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    console.log();
    console.log(fmt.bold(fmt.cyan("╭─────────────────────────────────────────╮")));
    console.log(fmt.bold(fmt.cyan("│")) + fmt.bold("   Welcome to Nexus — First-Time Setup   ") + fmt.bold(fmt.cyan("│")));
    console.log(fmt.bold(fmt.cyan("╰─────────────────────────────────────────╯")));
    console.log();
    console.log(fmt.dim("Let's personalize your agent. You can always edit these files later."));
    console.log(fmt.dim(`Files will be created in: ${workspaceDir}`));
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
    const userPronouns = await prompt(rl, "  Your pronouns (optional)", "");
    const userTimezone = await prompt(rl, "  Your timezone", Intl.DateTimeFormat().resolvedOptions().timeZone);
    const userContext = await prompt(rl, "  Anything the agent should know about you? (optional)", "");

    const userProfile = UserProfileSchema.parse({
      name: userName || undefined,
      pronouns: userPronouns || undefined,
      timezone: userTimezone,
      context: userContext || undefined,
    });

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
    console.log();

    const proceed = await confirm(rl, "Create personalization files?", true);
    if (!proceed) {
      console.log(fmt.dim("Skipped. You can run `nexus onboard` later."));
      return { identity, userProfile, skipped: true };
    }

    return { identity, userProfile, skipped: false };
  } finally {
    rl.close();
  }
}

export async function writeOnboardingFiles(
  workspaceDir: string,
  identity: Identity,
  userProfile: UserProfile,
): Promise<void> {
  console.log();
  console.log(fmt.dim("Creating personalization files..."));

  await writePersonalizationFile(workspaceDir, SOUL_FILENAME, getDefaultSoulTemplate(identity));
  console.log(`  ${fmt.green("✓")} ${SOUL_FILENAME}`);

  await writePersonalizationFile(workspaceDir, AGENTS_FILENAME, getDefaultAgentsTemplate());
  console.log(`  ${fmt.green("✓")} ${AGENTS_FILENAME}`);

  await writePersonalizationFile(workspaceDir, IDENTITY_FILENAME, getDefaultIdentityTemplate(identity));
  console.log(`  ${fmt.green("✓")} ${IDENTITY_FILENAME}`);

  await writePersonalizationFile(workspaceDir, USER_FILENAME, getDefaultUserTemplate(userProfile));
  console.log(`  ${fmt.green("✓")} ${USER_FILENAME}`);

  await writePersonalizationFile(workspaceDir, TOOLS_FILENAME, getDefaultToolsTemplate());
  console.log(`  ${fmt.green("✓")} ${TOOLS_FILENAME}`);

  await writePersonalizationFile(workspaceDir, HEARTBEAT_FILENAME, getDefaultHeartbeatTemplate());
  console.log(`  ${fmt.green("✓")} ${HEARTBEAT_FILENAME}`);

  await writePersonalizationFile(workspaceDir, NOTES_FILENAME, getDefaultNotesTemplate());
  console.log(`  ${fmt.green("✓")} ${NOTES_FILENAME}`);

  console.log();
  console.log(fmt.bold(fmt.green("✓ Onboarding complete!")));
  console.log(fmt.dim(`  Edit files in ${workspaceDir} to customize further.`));
  console.log();
}

export async function shouldRunOnboarding(workspaceDir: string): Promise<boolean> {
  // If SOUL.md doesn't exist, we should run onboarding
  return !(await personalizationFileExists(workspaceDir, SOUL_FILENAME));
}

export async function runOnboardingIfNeeded(
  workspaceDir: string,
  options: { interactive: boolean } = { interactive: true },
): Promise<void> {
  const needsOnboarding = await shouldRunOnboarding(workspaceDir);
  if (!needsOnboarding) return;

  if (!options.interactive) {
    // Non-interactive: create defaults silently
    const identity = IdentitySchema.parse({});
    const userProfile = UserProfileSchema.parse({});
    await writeOnboardingFilesQuiet(workspaceDir, identity, userProfile);
    return;
  }

  // Check if we're in a TTY
  if (!process.stdin.isTTY) {
    const identity = IdentitySchema.parse({});
    const userProfile = UserProfileSchema.parse({});
    await writeOnboardingFilesQuiet(workspaceDir, identity, userProfile);
    return;
  }

  const result = await runOnboarding(workspaceDir);
  if (!result.skipped) {
    await writeOnboardingFiles(workspaceDir, result.identity, result.userProfile);
  }
}

async function writeOnboardingFilesQuiet(
  workspaceDir: string,
  identity: Identity,
  userProfile: UserProfile,
): Promise<void> {
  await writePersonalizationFile(workspaceDir, SOUL_FILENAME, getDefaultSoulTemplate(identity));
  await writePersonalizationFile(workspaceDir, AGENTS_FILENAME, getDefaultAgentsTemplate());
  await writePersonalizationFile(workspaceDir, IDENTITY_FILENAME, getDefaultIdentityTemplate(identity));
  await writePersonalizationFile(workspaceDir, USER_FILENAME, getDefaultUserTemplate(userProfile));
  await writePersonalizationFile(workspaceDir, TOOLS_FILENAME, getDefaultToolsTemplate());
  await writePersonalizationFile(workspaceDir, HEARTBEAT_FILENAME, getDefaultHeartbeatTemplate());
  await writePersonalizationFile(workspaceDir, NOTES_FILENAME, getDefaultNotesTemplate());
}
