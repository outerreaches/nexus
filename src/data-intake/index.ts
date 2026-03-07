import { registerDataSources } from "./registry.js";
import { GENERATED_DATA_SOURCES } from "./generated-sources.js";

let initialized = false;

export function initDataIntake(): void {
  if (initialized) return;
  registerDataSources([...GENERATED_DATA_SOURCES]);
  initialized = true;
}

export * from "./types.js";
export * from "./registry.js";
export * from "./runner.js";
export * from "./store.js";
export * from "./source-store.js";
