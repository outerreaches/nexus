import { registerBuiltInSources } from "./sources/index.js";

let initialized = false;

export function initDataIntake(): void {
  if (initialized) return;
  registerBuiltInSources();
  initialized = true;
}

export * from "./types.js";
export * from "./registry.js";
export * from "./runner.js";
export * from "./store.js";
export * from "./source-store.js";
