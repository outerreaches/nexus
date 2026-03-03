import { spawn } from "node:child_process";

export type RunCommandCallbacks = {
  onTitle?: (title: string) => void;
  onCommand?: (cmd: string, args: string[]) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onDryRun?: (title: string) => void;
  onWarn?: (msg: string) => void;
};

export type RunCommandOptions = {
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  tolerateFailure?: boolean;
  dryRun?: boolean;
  callbacks?: RunCommandCallbacks;
};

export async function runCommand(
  title: string,
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<void> {
  const { env, interactive, tolerateFailure, dryRun, callbacks } = options;

  callbacks?.onTitle?.(title);
  callbacks?.onCommand?.(command, args);

  if (dryRun) {
    callbacks?.onDryRun?.(title);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: env ?? process.env,
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    });

    if (!interactive) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => callbacks?.onStdout?.(chunk));
      child.stderr?.on("data", (chunk: string) => callbacks?.onStderr?.(chunk));
    }

    child.on("error", (err) => {
      if (tolerateFailure) {
        callbacks?.onWarn?.(err.message);
        resolve();
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const msg = `command failed (${command}), exit=${code ?? "unknown"}`;
      if (tolerateFailure) {
        callbacks?.onWarn?.(msg);
        resolve();
      } else {
        reject(new Error(msg));
      }
    });
  });
}
