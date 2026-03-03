import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

type UninstallOptions = {
  yes?: boolean;
  nonInteractive?: boolean;
  dryRun?: boolean;
};

type RunCommandOptions = {
  tolerateFailure?: boolean;
};

async function runCommand(
  title: string,
  command: string,
  args: string[],
  dryRun: boolean,
  options: RunCommandOptions = {},
): Promise<void> {
  process.stdout.write(`[uninstall] ${title}\n`);
  process.stdout.write(`[uninstall] $ ${command} ${args.join(" ")}\n`);
  if (dryRun) {
    process.stdout.write("[uninstall] dry-run: command skipped\n");
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const err = new Error(`command failed (${command}), exit=${code ?? "unknown"}`);
      if (options.tolerateFailure) {
        process.stdout.write(`[uninstall] warn: ${err.message}; continuing\n`);
        resolve();
        return;
      }
      reject(err);
    });
  });
}

async function promptConfirm(question: string, nonInteractive: boolean): Promise<boolean> {
  if (nonInteractive) return false;
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${question} [y/N]: `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function removeFileIfExists(targetPath: string, dryRun: boolean): Promise<void> {
  if (!(await fileExists(targetPath))) {
    process.stdout.write(`[uninstall] skip missing file: ${targetPath}\n`);
    return;
  }
  if (dryRun) {
    process.stdout.write(`[uninstall] dry-run: would remove ${targetPath}\n`);
    return;
  }
  await fs.unlink(targetPath);
  process.stdout.write(`[uninstall] removed ${targetPath}\n`);
}

async function uninstallSystemd(dryRun: boolean): Promise<void> {
  await runCommand("Disable ha-deployer", "sudo", ["systemctl", "disable", "--now", "ha-deployer"], dryRun, {
    tolerateFailure: true,
  });
  await runCommand(
    "Remove systemd service file",
    "sudo",
    ["rm", "-f", "/etc/systemd/system/ha-deployer.service"],
    dryRun,
    { tolerateFailure: true },
  );
  await runCommand(
    "Remove systemd override file",
    "sudo",
    ["rm", "-f", "/etc/systemd/system/ha-deployer.service.d/nexus-paths.conf"],
    dryRun,
    { tolerateFailure: true },
  );
  await runCommand(
    "Remove systemd override directory when empty",
    "sudo",
    ["rmdir", "/etc/systemd/system/ha-deployer.service.d"],
    dryRun,
    { tolerateFailure: true },
  );
  await runCommand("Reload systemd", "sudo", ["systemctl", "daemon-reload"], dryRun, { tolerateFailure: true });
}

async function uninstallLaunchd(dryRun: boolean): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid < 0) {
    throw new Error("unable to determine user id for launchd uninstall");
  }
  const serviceLabel = "io.outerreaches.nexus.ha-deployer";
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${serviceLabel}.plist`);

  for (const domain of [`gui/${uid}`, `user/${uid}`]) {
    await runCommand(`Unload launchd job (${domain})`, "launchctl", ["bootout", domain, plistPath], dryRun, {
      tolerateFailure: true,
    });
    await runCommand(`Disable launchd job (${domain})`, "launchctl", ["disable", `${domain}/${serviceLabel}`], dryRun, {
      tolerateFailure: true,
    });
  }

  await removeFileIfExists(plistPath, dryRun);
}

export async function runUninstall(opts: UninstallOptions): Promise<void> {
  const dryRun = Boolean(opts.dryRun);
  const nonInteractive = Boolean(opts.nonInteractive);
  const yes = Boolean(opts.yes);
  const confirmed = yes || (await promptConfirm("Remove ha-deployer autostart integration", nonInteractive));
  if (!confirmed) {
    if (nonInteractive || !stdin.isTTY || !stdout.isTTY) {
      throw new Error("confirmation required; re-run with --yes to proceed");
    }
    process.stdout.write("[uninstall] canceled by user\n");
    return;
  }

  if (process.platform === "linux") {
    await uninstallSystemd(dryRun);
    process.stdout.write("[uninstall] done: removed systemd integration for ha-deployer\n");
    return;
  }
  if (process.platform === "darwin") {
    await uninstallLaunchd(dryRun);
    process.stdout.write("[uninstall] done: removed launchd integration for ha-deployer\n");
    return;
  }
  throw new Error(`unsupported platform for autostart uninstall: ${process.platform}`);
}
