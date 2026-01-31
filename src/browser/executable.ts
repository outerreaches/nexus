import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function which(cmd: string): Promise<string | null> {
  const envPath = process.env.PATH ?? "";
  const parts = envPath.split(path.delimiter).filter(Boolean);
  for (const dir of parts) {
    const candidate = path.join(dir, cmd);
    if (await exists(candidate)) return candidate;
    if (os.platform() === "win32") {
      const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";");
      for (const ext of exts) {
        const c = candidate + ext.toLowerCase();
        if (await exists(c)) return c;
      }
    }
  }
  return null;
}

export async function findBrowserExecutable(): Promise<string> {
  if (process.env.NEXUS_BROWSER_EXECUTABLE_PATH) return process.env.NEXUS_BROWSER_EXECUTABLE_PATH;

  const platform = os.platform();
  if (platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    for (const c of candidates) if (await exists(c)) return c;
  }

  if (platform === "linux") {
    const candidates = ["google-chrome", "chromium-browser", "chromium", "brave-browser", "microsoft-edge"];
    for (const c of candidates) {
      const found = await which(c);
      if (found) return found;
    }
  }

  if (platform === "win32") {
    const candidates = [
      "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe",
      "C:\\\\Program Files (x86)\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe",
      "C:\\\\Program Files\\\\BraveSoftware\\\\Brave-Browser\\\\Application\\\\brave.exe",
      "C:\\\\Program Files\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe",
    ];
    for (const c of candidates) if (await exists(c)) return c;
  }

  throw new Error(
    "No Chromium-based browser found. Set NEXUS_BROWSER_EXECUTABLE_PATH to your Chrome/Brave/Edge executable.",
  );
}

