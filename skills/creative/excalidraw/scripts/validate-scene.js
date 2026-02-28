#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error("Usage: node scripts/validate-scene.js <scene-file>");
}

const scenePath = process.argv[2];
if (!scenePath) {
  usage();
  process.exit(1);
}

const absPath = path.resolve(scenePath);

let raw;
try {
  raw = fs.readFileSync(absPath, "utf8");
} catch (err) {
  console.error(`Failed to read scene file: ${absPath}`);
  console.error(String(err));
  process.exit(1);
}

let scene;
try {
  scene = JSON.parse(raw);
} catch (err) {
  console.error(`Invalid JSON: ${absPath}`);
  console.error(String(err));
  process.exit(1);
}

const errors = [];

const topLevelRequired = ["type", "version", "source", "elements", "appState", "files"];
for (const key of topLevelRequired) {
  if (!(key in scene)) {
    errors.push(`Missing top-level key: ${key}`);
  }
}

if (scene.type !== "excalidraw") {
  errors.push(`Expected type="excalidraw", got "${scene.type}"`);
}

if (scene.version !== 2) {
  errors.push(`Expected version=2, got "${scene.version}"`);
}

if (!Array.isArray(scene.elements)) {
  errors.push("Expected elements to be an array");
}

const elementRequired = [
  "id",
  "type",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "groupIds",
  "frameId",
  "roundness",
  "seed",
  "version",
  "versionNonce",
  "isDeleted",
  "boundElements",
  "updated",
  "link",
  "locked",
];

if (Array.isArray(scene.elements)) {
  const seenIds = new Set();
  scene.elements.forEach((element, idx) => {
    if (typeof element !== "object" || element === null) {
      errors.push(`elements[${idx}] must be an object`);
      return;
    }
    for (const key of elementRequired) {
      if (!(key in element)) {
        errors.push(`elements[${idx}] missing key: ${key}`);
      }
    }
    if ("id" in element) {
      if (seenIds.has(element.id)) {
        errors.push(`elements[${idx}] has duplicate id: ${element.id}`);
      }
      seenIds.add(element.id);
    }
  });
}

if (errors.length > 0) {
  console.error(`Scene validation failed for ${absPath}:`);
  for (const err of errors) {
    console.error(`- ${err}`);
  }
  process.exit(1);
}

console.log(`Scene validation passed: ${absPath}`);
