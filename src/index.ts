// deploy pipeline smoke test — 2026-05-28
// Main entry point for the Nexus agent system.
// Initializes environment and runs the command-line interface.
import "./env.js";
import { runCli } from "./cli/app.js";

await runCli(process.argv);
