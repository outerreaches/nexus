#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  console.error("Usage: node scripts/new-scene.js <output-file>");
}

const outputPath = process.argv[2];
if (!outputPath) {
  usage();
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(scriptDir, "../reference/scene-template.excalidraw.json");

let templateRaw;
try {
  templateRaw = fs.readFileSync(templatePath, "utf8");
} catch (err) {
  console.error(`Failed to read template: ${templatePath}`);
  console.error(String(err));
  process.exit(1);
}

let scene;
try {
  scene = JSON.parse(templateRaw);
} catch (err) {
  console.error(`Template JSON is invalid: ${templatePath}`);
  console.error(String(err));
  process.exit(1);
}

scene.updated = Date.now();

try {
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(scene, null, 2)}\n`, "utf8");
} catch (err) {
  console.error(`Failed to write scene: ${outputPath}`);
  console.error(String(err));
  process.exit(1);
}

console.log(`Created Excalidraw scene: ${path.resolve(outputPath)}`);
