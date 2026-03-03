import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import JSON5 from "json5";

import { ConfigSchema, type NexusConfig } from "./config.js";

export type ConfigRoutingTarget =
  | { kind: "orchestrator" }
  | { kind: "preset"; preset: string }
  | { kind: "tool"; tool: string }
  | { kind: "toolPreset"; preset: string; tool: string };

export type ConfigRoutingField = "provider" | "model";

type ObjectSpan = {
  start: number;
  end: number;
};

type PropertySpan = {
  key: string;
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
  hasTrailingComma: boolean;
};

const DEFAULT_LOCK_TIMEOUT_MS = 8_000;
const DEFAULT_LOCK_POLL_MS = 100;
const DEFAULT_INDENT = "  ";

export async function editNexusConfigFile(params: {
  configPath: string;
  mutate: (rawConfig: Record<string, unknown>) => void;
  mutateText?: (rawText: string) => string | null;
  lockTimeoutMs?: number;
  lockPollMs?: number;
}): Promise<{ rawConfig: Record<string, unknown>; parsedConfig: NexusConfig }> {
  const timeoutMs = Math.max(500, params.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const pollMs = Math.max(25, params.lockPollMs ?? DEFAULT_LOCK_POLL_MS);
  const lockPath = `${params.configPath}.lock`;

  const release = await acquireLock(lockPath, timeoutMs, pollMs);
  try {
    const rawText = await fs.readFile(params.configPath, "utf8");
    const parsed = JSON5.parse(rawText) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("config root must be an object");
    }

    params.mutate(parsed);
    const parsedConfig = ConfigSchema.parse(parsed);

    let nextText: string;
    if (params.mutateText) {
      const candidateText = params.mutateText(rawText);
      if (typeof candidateText !== "string") {
        throw new Error("text edit failed for config mutation");
      }
      const candidateParsed = JSON5.parse(candidateText) as unknown;
      if (!isRecord(candidateParsed)) {
        throw new Error("text edit produced non-object config");
      }
      const candidateConfig = ConfigSchema.parse(candidateParsed);
      if (!isDeepStrictEqual(candidateConfig, parsedConfig)) {
        throw new Error("text edit does not match validated config mutation");
      }
      nextText = ensureTrailingNewline(candidateText);
    } else {
      nextText = `${JSON.stringify(parsed, null, 2)}\n`;
    }

    await writeConfigAtomically(params.configPath, nextText);
    return {
      rawConfig: parsed,
      parsedConfig,
    };
  } finally {
    await release();
  }
}

export async function editNexusConfigRoutingField(params: {
  configPath: string;
  target: ConfigRoutingTarget;
  field: ConfigRoutingField;
  action: "set" | "reset";
  value?: string;
  lockTimeoutMs?: number;
  lockPollMs?: number;
}): Promise<{ rawConfig: Record<string, unknown>; parsedConfig: NexusConfig }> {
  return await editNexusConfigFile({
    configPath: params.configPath,
    lockTimeoutMs: params.lockTimeoutMs,
    lockPollMs: params.lockPollMs,
    mutate: (rawConfig) => {
      applyRoutingFieldEdit({
        rawConfig,
        target: params.target,
        field: params.field,
        action: params.action,
        value: params.value,
      });
    },
    mutateText: (rawText) =>
      applyRoutingFieldTextEdit({
        text: rawText,
        target: params.target,
        field: params.field,
        action: params.action,
        value: params.value,
      }),
  });
}

export function applyRoutingFieldEdit(params: {
  rawConfig: Record<string, unknown>;
  target: ConfigRoutingTarget;
  field: ConfigRoutingField;
  action: "set" | "reset";
  value?: string;
}): void {
  if (params.action === "set") {
    const value = (params.value ?? "").trim();
    if (!value) throw new Error(`cannot set empty ${params.field}`);
    applySet(params.rawConfig, params.target, params.field, value);
    return;
  }
  applyReset(params.rawConfig, params.target, params.field);
}

export function applyRoutingFieldTextEdit(params: {
  text: string;
  target: ConfigRoutingTarget;
  field: ConfigRoutingField;
  action: "set" | "reset";
  value?: string;
}): string | null {
  const pathSegments = routingTextPath(params.target, params.field);
  if (pathSegments.length === 0) return null;
  if (params.action === "set") {
    const value = (params.value ?? "").trim();
    if (!value) return null;
    return setStringValueAtPath(params.text, pathSegments, value);
  }
  return deletePath(params.text, pathSegments);
}

async function acquireLock(lockPath: string, timeoutMs: number, pollMs: number): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
      return async () => {
        try {
          await handle.close();
        } finally {
          await fs.unlink(lockPath).catch(() => {});
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw err;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`config lock timeout: ${path.basename(lockPath)}`);
      }
      await sleep(pollMs);
    }
  }
}

async function writeConfigAtomically(configPath: string, text: string): Promise<void> {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    await fs.writeFile(tmpPath, ensureTrailingNewline(text), "utf8");
    await fs.rename(tmpPath, configPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function routingTextPath(target: ConfigRoutingTarget, field: ConfigRoutingField): string[] {
  if (target.kind === "orchestrator") {
    return ["llm", "routing", "byPreset", "orchestrator", "primary", field];
  }
  if (target.kind === "preset") {
    return ["llm", "routing", "byPreset", target.preset, "primary", field];
  }
  if (target.kind === "tool") {
    return ["llm", "toolRouting", "default", target.tool, field];
  }
  return ["llm", "toolRouting", "byPreset", target.preset, target.tool, field];
}

function setStringValueAtPath(text: string, pathSegments: string[], value: string): string | null {
  let next = text;
  const parentPath = pathSegments.slice(0, -1);
  const finalKey = pathSegments[pathSegments.length - 1];
  if (!finalKey) return null;

  for (let i = 0; i < parentPath.length; i += 1) {
    const containerPath = parentPath.slice(0, i);
    const key = parentPath[i];
    if (!key) return null;

    const containerObj = findObjectByPath(next, containerPath);
    if (!containerObj) return null;
    const prop = findPropertyInObject(next, containerObj, key);
    if (!prop) {
      next = insertProperty(next, containerObj, key, "{}");
      continue;
    }

    const valueStart = skipWhitespaceAndComments(next, prop.valueStart, prop.valueEnd);
    if (valueStart >= prop.valueEnd || next[valueStart] !== "{") {
      next = replaceRange(next, prop.valueStart, prop.valueEnd, "{}");
    }
  }

  const parentObj = findObjectByPath(next, parentPath);
  if (!parentObj) return null;
  const valueString = JSON.stringify(value);
  return setPropertyValue(next, parentObj, finalKey, valueString);
}

function deletePath(text: string, pathSegments: string[]): string | null {
  if (pathSegments.length === 0) return null;

  let next = text;
  const parentPath = pathSegments.slice(0, -1);
  const finalKey = pathSegments[pathSegments.length - 1];
  if (!finalKey) return null;

  const parentObj = findObjectByPath(next, parentPath);
  if (!parentObj) return next;

  const prop = findPropertyInObject(next, parentObj, finalKey);
  if (!prop) return next;

  next = removeProperty(next, parentObj, prop);

  // Best-effort cleanup for now-empty intermediate objects.
  for (let depth = parentPath.length - 1; depth >= 1; depth -= 1) {
    const containerPath = parentPath.slice(0, depth);
    const key = parentPath[depth];
    if (!key) break;

    const containerObjSpan = findObjectByPath(next, containerPath);
    if (!containerObjSpan) break;

    const childProp = findPropertyInObject(next, containerObjSpan, key);
    if (!childProp) continue;

    const childValueStart = skipWhitespaceAndComments(next, childProp.valueStart, childProp.valueEnd);
    if (childValueStart >= childProp.valueEnd || next[childValueStart] !== "{") break;

    const childObjectEnd = findEnclosedEnd(next, childValueStart, "{", "}");
    if (childObjectEnd === null) break;
    const childSpan: ObjectSpan = { start: childValueStart, end: childObjectEnd };
    if (hasAnyPropertyInObject(next, childSpan)) break;

    next = removeProperty(next, containerObjSpan, childProp);
  }

  return next;
}

function setPropertyValue(text: string, objectSpan: ObjectSpan, key: string, valueText: string): string {
  const existing = findPropertyInObject(text, objectSpan, key);
  if (existing) {
    return replaceRange(text, existing.valueStart, existing.valueEnd, valueText);
  }
  return insertProperty(text, objectSpan, key, valueText);
}

function insertProperty(text: string, objectSpan: ObjectSpan, key: string, valueText: string): string {
  const insertPos = findInsertionPosition(text, objectSpan);
  const trailing = text.slice(insertPos, objectSpan.end);
  const indentUnit = detectIndentUnit(text);
  const closingIndent = lineIndent(text, objectSpan.end);
  const entryIndent = `${closingIndent}${indentUnit}`;
  const hasExistingProps = hasAnyPropertyInObject(text, objectSpan);
  const needsComma = hasExistingProps && !hasTrailingCommaBeforeClosingBrace(text, objectSpan, insertPos);
  const serializedKey = JSON.stringify(key);
  const insertion = `${needsComma ? "," : ""}\n${entryIndent}${serializedKey}: ${valueText}`;
  return replaceRange(text, insertPos, objectSpan.end, `${insertion}${trailing}`);
}

function removeProperty(text: string, objectSpan: ObjectSpan, prop: PropertySpan): string {
  let start = prop.start;
  const end = prop.end;

  if (!prop.hasTrailingComma) {
    const prev = skipWhitespaceBack(text, start - 1, objectSpan.start + 1);
    if (prev >= objectSpan.start + 1 && text[prev] === ",") {
      start = prev;
    }
  }

  return replaceRange(text, start, end, "");
}

function findObjectByPath(text: string, pathSegments: string[]): ObjectSpan | null {
  let current = findRootObject(text);
  if (!current) return null;
  for (const segment of pathSegments) {
    const prop = findPropertyInObject(text, current, segment);
    if (!prop) return null;
    const valueStart = skipWhitespaceAndComments(text, prop.valueStart, prop.valueEnd);
    if (valueStart >= prop.valueEnd || text[valueStart] !== "{") return null;
    const valueEnd = findEnclosedEnd(text, valueStart, "{", "}");
    if (valueEnd === null) return null;
    current = { start: valueStart, end: valueEnd };
  }
  return current;
}

function findRootObject(text: string): ObjectSpan | null {
  const start = skipWhitespaceAndComments(text, 0, text.length);
  if (start >= text.length || text[start] !== "{") return null;
  const end = findEnclosedEnd(text, start, "{", "}");
  if (end === null) return null;
  return { start, end };
}

function findPropertyInObject(text: string, objectSpan: ObjectSpan, key: string): PropertySpan | null {
  let i = objectSpan.start + 1;
  while (i < objectSpan.end) {
    i = skipWhitespaceAndComments(text, i, objectSpan.end);
    if (i >= objectSpan.end) break;
    const ch = text[i];
    if (ch === "}") break;
    if (ch === ",") {
      i += 1;
      continue;
    }

    const parsedKey = parseObjectKey(text, i, objectSpan.end);
    if (!parsedKey) return null;
    i = skipWhitespaceAndComments(text, parsedKey.end, objectSpan.end);
    if (i >= objectSpan.end || text[i] !== ":") return null;
    i += 1;

    const valueStart = skipWhitespaceAndComments(text, i, objectSpan.end);
    const valueEnd = parseValueEnd(text, valueStart, objectSpan.end);
    if (valueEnd === null) return null;

    let j = skipWhitespaceAndComments(text, valueEnd, objectSpan.end);
    let hasTrailingComma = false;
    let end = valueEnd;
    if (j < objectSpan.end && text[j] === ",") {
      hasTrailingComma = true;
      end = j + 1;
      j += 1;
    }

    const prop: PropertySpan = {
      key: parsedKey.key,
      start: parsedKey.start,
      end,
      valueStart,
      valueEnd,
      hasTrailingComma,
    };
    if (prop.key === key) return prop;
    i = j;
  }
  return null;
}

function hasAnyPropertyInObject(text: string, objectSpan: ObjectSpan): boolean {
  let i = objectSpan.start + 1;
  while (i < objectSpan.end) {
    i = skipWhitespaceAndComments(text, i, objectSpan.end);
    if (i >= objectSpan.end) break;
    const ch = text[i];
    if (ch === "}") return false;
    if (ch === ",") {
      i += 1;
      continue;
    }
    const parsedKey = parseObjectKey(text, i, objectSpan.end);
    if (!parsedKey) return false;
    return true;
  }
  return false;
}

function parseObjectKey(text: string, start: number, limit: number): { key: string; start: number; end: number } | null {
  if (start >= limit) return null;
  const ch = text[start];
  if (ch === '"' || ch === "'") {
    const stringEnd = findStringEnd(text, start, ch);
    if (stringEnd === null || stringEnd >= limit) return null;
    const token = text.slice(start, stringEnd + 1);
    let key = "";
    try {
      key = String(JSON5.parse(token));
    } catch {
      return null;
    }
    return {
      key,
      start,
      end: stringEnd + 1,
    };
  }

  let i = start;
  while (i < limit) {
    const c = text[i];
    if (!c) break;
    if (c === ":" || c === "," || c === "}" || c === "{" || c === "[" || c === "]") break;
    if (isWhitespace(c)) break;
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) break;
    i += 1;
  }
  if (i === start) return null;
  const key = text.slice(start, i).trim();
  if (!key) return null;
  return {
    key,
    start,
    end: i,
  };
}

function parseValueEnd(text: string, start: number, limit: number): number | null {
  if (start >= limit) return null;
  const ch = text[start];
  if (ch === "{") {
    const end = findEnclosedEnd(text, start, "{", "}");
    return end === null ? null : end + 1;
  }
  if (ch === "[") {
    const end = findEnclosedEnd(text, start, "[", "]");
    return end === null ? null : end + 1;
  }
  if (ch === '"' || ch === "'") {
    const end = findStringEnd(text, start, ch);
    return end === null ? null : end + 1;
  }

  let i = start;
  while (i < limit) {
    const c = text[i];
    if (!c) break;
    if (c === "," || c === "}" || c === "]") break;
    if (isWhitespace(c)) break;
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) break;
    i += 1;
  }
  if (i === start) return null;
  return i;
}

function findEnclosedEnd(text: string, start: number, openChar: "{" | "[", closeChar: "}" | "]"): number | null {
  let depth = 1;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (!ch) break;
    if (ch === '"' || ch === "'") {
      const end = findStringEnd(text, i, ch);
      if (end === null) return null;
      i = end + 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i = skipLineComment(text, i + 2);
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = skipBlockComment(text, i + 2);
      if (end === null) return null;
      i = end;
      continue;
    }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return null;
}

function findStringEnd(text: string, start: number, quote: string): number | null {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (!ch) break;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i;
    i += 1;
  }
  return null;
}

function skipWhitespaceAndComments(text: string, start: number, limit: number): number {
  let i = start;
  while (i < limit) {
    const ch = text[i];
    if (!ch) break;
    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i = skipLineComment(text, i + 2);
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = skipBlockComment(text, i + 2);
      if (end === null) return limit;
      i = end;
      continue;
    }
    break;
  }
  return i;
}

function skipWhitespaceBack(text: string, start: number, min: number): number {
  let i = start;
  while (i >= min) {
    const ch = text[i];
    if (!ch || !isWhitespace(ch)) break;
    i -= 1;
  }
  return i;
}

function skipLineComment(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n" || ch === "\r") return i + 1;
    i += 1;
  }
  return i;
}

function skipBlockComment(text: string, start: number): number | null {
  const end = text.indexOf("*/", start);
  if (end === -1) return null;
  return end + 2;
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function lineIndent(text: string, index: number): string {
  const lineStart = findLineStart(text, index);
  let i = lineStart;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t") {
      i += 1;
      continue;
    }
    break;
  }
  return text.slice(lineStart, i);
}

function findLineStart(text: string, index: number): number {
  let i = Math.max(0, Math.min(index, text.length));
  while (i > 0 && text[i - 1] !== "\n" && text[i - 1] !== "\r") {
    i -= 1;
  }
  return i;
}

function detectIndentUnit(text: string): string {
  const lines = text.split(/\r?\n/);
  let best = "";
  for (const line of lines) {
    const match = /^(\s+)["'][^"']+["']\s*:/.exec(line);
    if (!match) continue;
    const indent = match[1] ?? "";
    if (indent.length > 0 && (best.length === 0 || indent.length < best.length)) {
      best = indent;
    }
  }
  if (best.length >= 2 && best.trim().length === 0) {
    return best.slice(-2);
  }
  if (best === "\t") return "\t";
  return DEFAULT_INDENT;
}

function hasTrailingCommaBeforeClosingBrace(text: string, objectSpan: ObjectSpan, insertPos: number): boolean {
  const prev = skipWhitespaceBack(text, insertPos - 1, objectSpan.start + 1);
  return prev >= objectSpan.start + 1 && text[prev] === ",";
}

function findInsertionPosition(text: string, objectSpan: ObjectSpan): number {
  let i = objectSpan.end;
  while (i > objectSpan.start + 1) {
    const prev = text[i - 1];
    if (!prev || !isWhitespace(prev)) break;
    i -= 1;
  }
  return i;
}

function replaceRange(text: string, start: number, end: number, value: string): string {
  return `${text.slice(0, start)}${value}${text.slice(end)}`;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function applySet(
  root: Record<string, unknown>,
  target: ConfigRoutingTarget,
  field: ConfigRoutingField,
  value: string,
): void {
  if (target.kind === "orchestrator" || target.kind === "preset") {
    const routePrimary = ensurePrimaryRouteTarget(root, target.kind === "orchestrator" ? "orchestrator" : target.preset);
    routePrimary[field] = value;
    return;
  }
  const toolTarget = ensureToolRouteTarget(root, target);
  toolTarget[field] = value;
}

function applyReset(
  root: Record<string, unknown>,
  target: ConfigRoutingTarget,
  field: ConfigRoutingField,
): void {
  if (target.kind === "orchestrator" || target.kind === "preset") {
    const presetName = target.kind === "orchestrator" ? "orchestrator" : target.preset;
    const byPreset = getByPresetRouteMap(root);
    const route = asMutableRecord(byPreset[presetName]);
    if (!route) return;
    const primary = asMutableRecord(route.primary);
    if (!primary) return;
    delete primary[field];
    if (Object.keys(primary).length === 0) {
      delete route.primary;
    }
    if (Object.keys(route).length === 0) {
      delete byPreset[presetName];
    }
    return;
  }

  if (target.kind === "tool") {
    const defaultMap = getDefaultToolRouteMap(root);
    const toolRoute = asMutableRecord(defaultMap[target.tool]);
    if (!toolRoute) return;
    delete toolRoute[field];
    if (Object.keys(toolRoute).length === 0) {
      delete defaultMap[target.tool];
    }
    return;
  }

  const byPreset = getByPresetToolRouteMap(root);
  const presetMap = asMutableRecord(byPreset[target.preset]);
  if (!presetMap) return;
  const toolRoute = asMutableRecord(presetMap[target.tool]);
  if (!toolRoute) return;
  delete toolRoute[field];
  if (Object.keys(toolRoute).length === 0) {
    delete presetMap[target.tool];
  }
  if (Object.keys(presetMap).length === 0) {
    delete byPreset[target.preset];
  }
}

function ensurePrimaryRouteTarget(root: Record<string, unknown>, presetName: string): Record<string, unknown> {
  const byPreset = getByPresetRouteMap(root);
  const route = ensureRecordField(byPreset, presetName);
  return ensureRecordField(route, "primary");
}

function ensureToolRouteTarget(
  root: Record<string, unknown>,
  target: { kind: "tool"; tool: string } | { kind: "toolPreset"; preset: string; tool: string },
): Record<string, unknown> {
  if (target.kind === "tool") {
    const defaultMap = getDefaultToolRouteMap(root);
    return ensureRecordField(defaultMap, target.tool);
  }
  const byPreset = getByPresetToolRouteMap(root);
  const presetMap = ensureRecordField(byPreset, target.preset);
  return ensureRecordField(presetMap, target.tool);
}

function getByPresetRouteMap(root: Record<string, unknown>): Record<string, unknown> {
  const llm = ensureRecordField(root, "llm");
  const routing = ensureRecordField(llm, "routing");
  return ensureRecordField(routing, "byPreset");
}

function getDefaultToolRouteMap(root: Record<string, unknown>): Record<string, unknown> {
  const llm = ensureRecordField(root, "llm");
  const toolRouting = ensureRecordField(llm, "toolRouting");
  return ensureRecordField(toolRouting, "default");
}

function getByPresetToolRouteMap(root: Record<string, unknown>): Record<string, unknown> {
  const llm = ensureRecordField(root, "llm");
  const toolRouting = ensureRecordField(llm, "toolRouting");
  return ensureRecordField(toolRouting, "byPreset");
}

function ensureRecordField(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = root[key];
  if (isRecord(current)) return current;
  const created: Record<string, unknown> = {};
  root[key] = created;
  return created;
}

function asMutableRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
