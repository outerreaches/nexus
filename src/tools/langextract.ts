import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { OpenAICompatConfig } from "../llm/openai-compat.js";
import type { NexusDatabase } from "../storage/database.js";
import { resolveWithinRoots } from "./path-utils.js";

const FILE_ROOTS = ["workspace", "state", "code"] as const;
type FileRoot = (typeof FILE_ROOTS)[number];

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_WORKERS = 8;
const DEFAULT_EXTRACTION_PASSES = 1;
const DEFAULT_MAX_RESULT_EXTRACTIONS = 500;
const MAX_STDIO_BYTES = 5 * 1024 * 1024;
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

type BlackboardRow = {
  id: string;
  session_scope: string;
  title: string | null;
  content: string | null;
  attachments_json: string | null;
};

type BlackboardAttachment = {
  path?: string;
  statePath?: string;
  mimeType?: string;
};

type ResolvedSource =
  | {
    type: "text";
    value: string;
    sourceLabel: string;
  }
  | {
    type: "document";
    value: string;
    sourceLabel: string;
    sourceIsUrl: boolean;
  };

type PythonResult = {
  ok: boolean;
  error?: string;
  traceback?: string;
  meta?: {
    total_extractions?: number;
    returned_extractions?: number;
    truncated?: boolean;
    used_kwargs?: string[];
    source_kind?: string;
    source_is_url?: boolean;
    version?: string;
  };
  extractions?: unknown[];
};

const PYTHON_RUNNER = String.raw`from __future__ import annotations
import inspect
import json
import traceback

def _to_str_dict(raw):
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in raw.items():
        if k is None:
            continue
        out[str(k)] = "" if v is None else str(v)
    return out

def _build_examples(lx, payload):
    user_examples = payload.get("examples") or []
    if user_examples:
        built = []
        for item in user_examples:
            text = str(item.get("text") or "").strip()
            rows = item.get("extractions") or []
            exts = []
            for row in rows:
                exts.append(
                    lx.data.Extraction(
                        extraction_class=str(row.get("extractionClass") or "entity"),
                        extraction_text=str(row.get("extractionText") or ""),
                        attributes=_to_str_dict(row.get("attributes")),
                    )
                )
            built.append(lx.data.ExampleData(text=text, extractions=exts))
        return built

    classes = payload.get("extraction_classes") or ["entity"]
    classes = [str(c).strip() for c in classes if str(c).strip()]
    if not classes:
        classes = ["entity"]

    tokens = [f"sample_{i+1}" for i in range(len(classes))]
    example_text = " ".join(tokens)
    exts = []
    for cls, token in zip(classes, tokens):
        exts.append(
            lx.data.Extraction(
                extraction_class=cls,
                extraction_text=token,
                attributes={},
            )
        )
    return [lx.data.ExampleData(text=example_text, extractions=exts)]

def _serialize_char_interval(value):
    if value is None:
        return None
    start_pos = getattr(value, "start_pos", None)
    end_pos = getattr(value, "end_pos", None)
    if start_pos is None and end_pos is None and isinstance(value, dict):
        start_pos = value.get("start_pos")
        end_pos = value.get("end_pos")
    return {"start_pos": start_pos, "end_pos": end_pos}

def _serialize_extraction(value):
    attributes = getattr(value, "attributes", None)
    if not isinstance(attributes, dict):
        attributes = {}
    return {
        "extractionClass": getattr(value, "extraction_class", None),
        "extractionText": getattr(value, "extraction_text", None),
        "attributes": _to_str_dict(attributes),
        "charInterval": _serialize_char_interval(getattr(value, "char_interval", None)),
        "alignmentStatus": str(getattr(value, "alignment_status", None))
            if getattr(value, "alignment_status", None) is not None
            else None,
        "groupIndex": getattr(value, "group_index", None),
        "description": getattr(value, "description", None),
    }

def _load_openai_language_model_class():
    import importlib
    candidates = [
        ("langextract.providers.openai", "OpenAILanguageModel"),
        ("langextract.providers", "OpenAILanguageModel"),
        ("langextract.inference", "OpenAILanguageModel"),
    ]
    errors = []
    for module_name, attr_name in candidates:
        try:
            module = importlib.import_module(module_name)
            cls = getattr(module, attr_name, None)
            if cls is not None:
                return cls
            errors.append(f"{module_name}.{attr_name} not found")
        except Exception as exc:
            errors.append(f"{module_name}: {exc}")
    raise ImportError("Unable to import OpenAILanguageModel. Tried: " + "; ".join(errors))

def _build_openai_model(payload):
    OpenAILanguageModel = _load_openai_language_model_class()

    model_id = payload.get("model_id")
    if not isinstance(model_id, str) or not model_id.strip():
        raise ValueError("model_id is required for OpenAI provider")

    init_kwargs = {"model_id": model_id.strip()}
    model_url = payload.get("model_url")
    if isinstance(model_url, str) and model_url.strip():
        init_kwargs["base_url"] = model_url.strip()
    api_key = payload.get("api_key")
    if isinstance(api_key, str) and api_key.strip():
        init_kwargs["api_key"] = api_key.strip()

    return OpenAILanguageModel(**init_kwargs)

def _supports_parameter(sig, name):
    if name in sig.parameters:
        return True
    return any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())

def _resolve_documents(lx, source_kind, source_value, source_is_url):
    if source_kind == "text":
        return source_value

    # For URL document sources, pass the URL string directly.
    # Newer LangExtract versions expect a string URL (not list[str]) so it can
    # fetch text internally when fetch_urls=True.
    if source_is_url:
        return source_value

    # For non-URL document sources, try to wrap in langextract Document objects.
    doc_cls = getattr(getattr(lx, "data", None), "Document", None)
    if doc_cls is not None:
        try:
            sig = inspect.signature(doc_cls)
            params = list(sig.parameters.keys())
            # Try constructing with known param patterns
            if "path" in params:
                return [doc_cls(path=source_value)]
            if "uri" in params:
                return [doc_cls(uri=source_value)]
        except Exception:
            pass

    # Fallback: pass as plain string (avoid iterable[str] path that causes
    # "'str' object has no attribute 'document_id'" in newer versions).
    return source_value

def main():
    payload = json.load(sys.stdin)
    try:
        import langextract as lx
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "error": f"Failed to import langextract: {exc}",
            "traceback": traceback.format_exc(),
        }, ensure_ascii=False))
        return

    try:
        source_kind = payload.get("source_kind")
        source_value = payload.get("source_value")
        source_is_url = bool(payload.get("source_is_url", False))
        prompt_description = str(payload.get("prompt_description") or "").strip()
        max_result_extractions = int(payload.get("max_result_extractions") or 500)
        if max_result_extractions < 1:
            max_result_extractions = 1

        if source_kind not in ("text", "document"):
            raise ValueError("source_kind must be 'text' or 'document'")
        if not isinstance(source_value, str) or not source_value.strip():
            raise ValueError("source_value must be a non-empty string")
        if not prompt_description:
            raise ValueError("prompt_description is required")

        # Build OpenAI model — fail hard if this doesn't work.
        model = _build_openai_model(payload)

        text_or_documents = _resolve_documents(lx, source_kind, source_value, source_is_url)
        examples = _build_examples(lx, payload)

        kwargs = {
            "text_or_documents": text_or_documents,
            "prompt_description": prompt_description,
            "examples": examples,
            "model": model,
        }

        sig = inspect.signature(lx.extract)
        option_values = {
            "max_workers": payload.get("max_workers"),
            "extraction_passes": payload.get("extraction_passes"),
            "fence_output": payload.get("fence_output"),
            "use_schema_constraints": payload.get("use_schema_constraints"),
        }
        for key, value in option_values.items():
            if value is None:
                continue
            if _supports_parameter(sig, key):
                kwargs[key] = value
        if source_is_url and _supports_parameter(sig, "fetch_urls"):
            kwargs["fetch_urls"] = True

        result = lx.extract(**kwargs)
        all_extractions = [_serialize_extraction(e) for e in (getattr(result, "extractions", None) or [])]
        limited = all_extractions[:max_result_extractions]

        print(json.dumps({
            "ok": True,
            "meta": {
                "total_extractions": len(all_extractions),
                "returned_extractions": len(limited),
                "truncated": len(limited) < len(all_extractions),
                "used_kwargs": sorted(list(kwargs.keys())),
                "source_kind": source_kind,
                "source_is_url": source_is_url,
                "version": getattr(lx, "__version__", None),
            },
            "extractions": limited,
        }, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "error": str(exc),
            "traceback": traceback.format_exc(),
        }, ensure_ascii=False))

if __name__ == "__main__":
    import sys
    main()
`;

function requireDb(ctx: { db?: unknown }): NexusDatabase | null {
  return (ctx.db as NexusDatabase | undefined) ?? null;
}

function sessionScope(ctx: { request?: { sessionId: string } }): string {
  return ctx.request?.sessionId ?? "global";
}

function agentId(ctx: { request?: { agentId: string } }): string {
  return ctx.request?.agentId ?? "main";
}

function rootDir(ctx: { workspaceDir: string; stateDir: string; codeDir: string }, root: FileRoot): string {
  if (root === "workspace") return ctx.workspaceDir;
  if (root === "state") return ctx.stateDir;
  return ctx.codeDir;
}

function allowedRoots(ctx: { workspaceDir: string; stateDir: string; codeDir: string; allowCodeEdit?: boolean }): string[] {
  return [ctx.workspaceDir, ctx.stateDir, ...(ctx.allowCodeEdit ? [ctx.codeDir] : [])];
}

function normalizeRootPathPrefix(rawPath: string): { root: FileRoot; path: string } | null {
  const trimmed = rawPath.trim().replace(/^[\\/]+/, "");
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[\\]+/g, "/");
  for (const root of FILE_ROOTS) {
    const prefix = `${root}/`;
    if (normalized.startsWith(prefix)) {
      return {
        root,
        path: normalized.slice(prefix.length),
      };
    }
  }
  return null;
}

function parseAttachments(raw: string | null): BlackboardAttachment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && typeof entry === "object") as BlackboardAttachment[];
  } catch {
    return [];
  }
}

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function envString(name: string): string | undefined {
  const raw = (process.env[name] ?? "").trim();
  return raw || undefined;
}

function sanitizeFileStem(raw: string): string {
  const base = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!base) return "langextract";
  return base.slice(0, 80);
}

function resolveOpenRouterDefaults(params: {
  ctx: { llmConfig?: OpenAICompatConfig };
  modelOverride?: string;
  baseUrlOverride?: string;
  apiKeyOverride?: string;
}): {
  model: string | undefined;
  baseUrl: string | undefined;
  apiKey: string | undefined;
} {
  const routed = params.ctx.llmConfig;
  const model =
    params.modelOverride?.trim() ||
    envString("NEXUS_LANGEXTRACT_MODEL") ||
    envString("NEXUS_LANGEXTRACT_MODEL_ID") ||
    routed?.model?.trim();
  const baseUrl =
    params.baseUrlOverride?.trim() ||
    routed?.baseUrl?.trim() ||
    DEFAULT_OPENROUTER_BASE_URL;
  const apiKey =
    params.apiKeyOverride?.trim() ||
    routed?.apiKey?.trim() ||
    envString("OPENROUTER_API_KEY");
  return { model, baseUrl, apiKey };
}

function isLangextractParseLikeError(raw: string | undefined): boolean {
  const text = String(raw ?? "").toLowerCase();
  if (!text) return false;
  return (
    text.includes("failed to parse json content") ||
    text.includes("resolverparsingerror") ||
    text.includes("formatparseerror")
  );
}

function maybeJsonParse(raw: string): PythonResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as PythonResult;
  } catch {
    // Some libraries log before payload; parse last JSON-looking line.
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (!line.startsWith("{") && !line.startsWith("[")) continue;
      try {
        return JSON.parse(line) as PythonResult;
      } catch {
        continue;
      }
    }
    return null;
  }
}

function truncateForError(raw: string, maxChars = 2000): string {
  const text = raw.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

async function resolveSourceFromBlackboard(params: {
  ctx: {
    db?: unknown;
    request?: { sessionId: string };
    workspaceDir: string;
    stateDir: string;
    codeDir: string;
    allowCodeEdit?: boolean;
  };
  blackboardId: string;
  attachmentIndex: number;
}): Promise<ResolvedSource> {
  const db = requireDb(params.ctx);
  if (!db) throw new Error("database is not available");

  const row = db.db
    .prepare("SELECT id, session_scope, title, content, attachments_json FROM blackboard WHERE id = ?")
    .get(params.blackboardId) as BlackboardRow | undefined;
  if (!row) {
    throw new Error(`blackboard entry not found: ${params.blackboardId}`);
  }

  const scope = params.ctx.request?.sessionId;
  if (scope && row.session_scope !== scope && row.session_scope !== "global") {
    throw new Error("blackboard entry is outside current session scope");
  }

  const entryTitle = row.title ? ` (${row.title})` : "";
  const attachments = parseAttachments(row.attachments_json);
  if (attachments.length > 0) {
    const index = params.attachmentIndex - 1;
    if (index < 0 || index >= attachments.length) {
      throw new Error(
        `attachment index out of range (requested=${params.attachmentIndex}, available=${attachments.length})`,
      );
    }
    const attachment = attachments[index]!;
    let rawPath = attachment.path?.trim() ?? "";
    if (!rawPath) rawPath = attachment.statePath?.trim() ?? "";
    if (!rawPath) {
      throw new Error(`attachment ${params.attachmentIndex} has no path`);
    }

    const prefixed = normalizeRootPathPrefix(rawPath);
    const defaultRoot = prefixed ? rootDir(params.ctx, prefixed.root) : params.ctx.stateDir;
    const inputPath = prefixed ? prefixed.path : rawPath;
    const absolutePath = resolveWithinRoots({
      inputPath,
      defaultRoot,
      roots: allowedRoots(params.ctx),
    });
    return {
      type: "document",
      value: absolutePath,
      sourceLabel: `blackboard:${params.blackboardId}${entryTitle}#${params.attachmentIndex}`,
      sourceIsUrl: false,
    };
  }

  const content = String(row.content ?? "").trim();
  if (!content) {
    throw new Error(`blackboard entry has no attachments or text content: ${params.blackboardId}`);
  }

  return {
    type: "text",
    value: content,
    sourceLabel: `blackboard:${params.blackboardId}${entryTitle}`,
  };
}

async function runLangextractPython(params: {
  pythonBin: string;
  timeoutMs: number;
  payload: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<{ parsed: PythonResult; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(params.pythonBin, ["-c", PYTHON_RUNNER], {
      cwd: params.cwd,
      env: params.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, params.timeoutMs);

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_STDIO_BYTES) {
        stdout = stdout.slice(-MAX_STDIO_BYTES);
      }
    });

    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_STDIO_BYTES) {
        stderr = stderr.slice(-MAX_STDIO_BYTES);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`langextract timed out after ${params.timeoutMs}ms. Retry with a larger timeoutMs or reduce input size.`));
        return;
      }
      if (code !== 0) {
        const msg = [
          `langextract runner exited with code=${code} signal=${signal ?? "null"}`,
          stderr.trim() ? `STDERR:\n${truncateForError(stderr, 3000)}` : "",
          stdout.trim() ? `STDOUT:\n${truncateForError(stdout, 3000)}` : "",
        ].filter(Boolean).join("\n\n");
        reject(new Error(msg));
        return;
      }
      const parsed = maybeJsonParse(stdout);
      if (!parsed) {
        const msg = [
          "langextract runner returned non-JSON output",
          stderr.trim() ? `STDERR:\n${truncateForError(stderr, 2000)}` : "",
          stdout.trim() ? `STDOUT:\n${truncateForError(stdout, 3000)}` : "",
        ].filter(Boolean).join("\n\n");
        reject(new Error(msg));
        return;
      }
      resolve({ parsed, stderr });
    });

    proc.stdin.write(JSON.stringify(params.payload));
    proc.stdin.end();
  });
}

async function writeBlackboardArtifact(params: {
  ctx: { db?: unknown; request?: { sessionId: string; agentId: string; preset?: string }; nowMs: () => number };
  title: string;
  content: string;
  attachmentPath: string;
  metadata?: Record<string, unknown>;
  ttlMs?: number;
}): Promise<string> {
  const db = requireDb(params.ctx);
  if (!db) throw new Error("database is not available");

  const id = crypto.randomUUID();
  const nowMs = params.ctx.nowMs();
  const expiresAt = typeof params.ttlMs === "number" ? nowMs + params.ttlMs : null;
  db.db
    .prepare(
      `INSERT INTO blackboard (id, session_scope, type, agent_id, agent_preset, title, content, attachments_json, metadata_json, created_at, last_accessed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      sessionScope(params.ctx),
      "artifact",
      agentId(params.ctx),
      params.ctx.request?.preset ?? "unknown",
      params.title,
      params.content,
      JSON.stringify([{ path: params.attachmentPath, mimeType: "application/json" }]),
      JSON.stringify(params.metadata ?? {}),
      nowMs,
      nowMs,
      expiresAt,
    );
  return id;
}

export const langextractExtract = defineTool({
  name: "langextract_extract",
  description:
    "Run LangExtract structured extraction on text/documents and persist results as JSON. " +
    "Input can come from text, a file path, a URL, or a blackboard entry. " +
    "By default, writes output JSON to disk and creates a blackboard artifact entry.",
  parameters: z.object({
    text: z.string().max(1_000_000).optional().describe("Inline source text to extract from."),
    path: z.string().optional().describe("File path source (relative to root or absolute inside allowed roots)."),
    root: z.enum(FILE_ROOTS).default("workspace").describe("Root for resolving `path`."),
    url: z.string().url().optional().describe("URL source (passed to LangExtract as a document URL)."),
    blackboardId: z.string().optional().describe("Blackboard entry ID source."),
    attachmentIndex: z.number().int().positive().default(1).describe("Attachment index for blackboardId (1-based)."),

    promptDescription: z.string().min(1).max(4000).describe("What information to extract."),
    extractionClasses: z.array(z.string().min(1).max(120)).min(1).max(50).default(["entity"])
      .describe("Target extraction classes."),
    examples: z.array(z.object({
      text: z.string().min(1).max(12_000),
      extractions: z.array(z.object({
        extractionClass: z.string().min(1).max(120),
        extractionText: z.string().min(1).max(500),
        attributes: z.record(z.string()).default({}),
      })).min(1).max(100),
    })).max(10).optional().describe("Optional LangExtract examples. If omitted, synthetic examples are generated."),

    model: z.string().max(200).optional().describe("Optional OpenRouter model override (e.g. openai/gpt-4.1-mini)."),
    modelId: z.string().max(200).optional().describe("Alias for `model` (deprecated)."),
    modelUrl: z.string().url().max(2000).optional().describe("Optional OpenRouter base URL override."),
    apiKey: z.string().max(500).optional().describe("Optional OpenRouter API key override."),
    maxWorkers: z.number().int().min(1).max(64).default(DEFAULT_MAX_WORKERS),
    extractionPasses: z.number().int().min(1).max(10).default(DEFAULT_EXTRACTION_PASSES),
    fenceOutput: z.boolean().default(true),
    useSchemaConstraints: z.boolean().default(false),
    maxResultExtractions: z.number().int().min(1).max(5000).default(DEFAULT_MAX_RESULT_EXTRACTIONS),
    timeoutMs: z.number().int().min(10_000).max(600_000).default(DEFAULT_TIMEOUT_MS),

    outputRoot: z.enum(FILE_ROOTS).default("workspace").describe("Root for output JSON file."),
    outputPath: z.string().optional().describe("Optional output path (relative to outputRoot or absolute in allowed roots)."),
    writeToBlackboard: z.boolean().default(true).describe("Write output artifact reference to blackboard."),
    blackboardTitle: z.string().max(200).optional().describe("Optional blackboard title override."),
    blackboardTtlMs: z.number().int().min(60_000).max(30 * 24 * 60 * 60_000).optional(),
  }).superRefine((args, refineCtx) => {
    const provided = [args.text, args.path, args.url, args.blackboardId].filter((value) => typeof value === "string" && value.trim().length > 0);
    if (provided.length !== 1) {
      refineCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "Provide exactly one source: text, path, url, or blackboardId.",
      });
    }
  }),
  execute: async (args, ctx) => {
    if (args.root === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy";
    if (args.outputRoot === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy";

    try {
      let source: ResolvedSource;
      if (typeof args.text === "string" && args.text.trim()) {
        source = {
          type: "text",
          value: args.text.trim(),
          sourceLabel: "inline:text",
        };
      } else if (typeof args.path === "string" && args.path.trim()) {
        const absolutePath = resolveWithinRoots({
          inputPath: args.path,
          defaultRoot: rootDir(ctx, args.root),
          roots: allowedRoots(ctx),
        });
        source = {
          type: "document",
          value: absolutePath,
          sourceLabel: `file:${absolutePath}`,
          sourceIsUrl: false,
        };
      } else if (typeof args.url === "string" && args.url.trim()) {
        source = {
          type: "document",
          value: args.url.trim(),
          sourceLabel: `url:${args.url.trim()}`,
          sourceIsUrl: true,
        };
      } else if (typeof args.blackboardId === "string" && args.blackboardId.trim()) {
        source = await resolveSourceFromBlackboard({
          ctx,
          blackboardId: args.blackboardId.trim(),
          attachmentIndex: args.attachmentIndex,
        });
      } else {
        return "ERROR: missing valid source input";
      }

      const pythonBin = (process.env.NEXUS_LANGEXTRACT_PYTHON ?? "python3").trim() || "python3";
      const resolvedLlm = resolveOpenRouterDefaults({
        ctx,
        modelOverride: args.model ?? args.modelId,
        baseUrlOverride: args.modelUrl,
        apiKeyOverride: args.apiKey,
      });
      const timeoutMs = Math.max(10_000, args.timeoutMs || envInt("NEXUS_LANGEXTRACT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));

      if (!resolvedLlm.baseUrl) {
        return "ERROR: missing OpenRouter base URL for langextract_extract. Configure llm.openaiCompat.baseUrl.";
      }
      if (!resolvedLlm.model) {
        return "ERROR: missing OpenRouter model for langextract_extract. Configure llm.openaiCompat.model in Nexus config or pass `model`.";
      }
      if (!resolvedLlm.apiKey) {
        return "ERROR: missing OpenRouter API key for langextract_extract. Set OPENROUTER_API_KEY (or llm.openaiCompat.apiKey).";
      }

      const pyPayload: Record<string, unknown> = {
        source_kind: source.type,
        source_value: source.value,
        source_is_url: source.type === "document" ? source.sourceIsUrl : false,
        prompt_description: args.promptDescription,
        extraction_classes: args.extractionClasses,
        examples: args.examples,
        model_type: "openai",
        model_id: resolvedLlm.model,
        model_url: resolvedLlm.baseUrl,
        api_key: resolvedLlm.apiKey,
        max_workers: args.maxWorkers,
        extraction_passes: args.extractionPasses,
        fence_output: args.fenceOutput,
        use_schema_constraints: args.useSchemaConstraints,
        max_result_extractions: args.maxResultExtractions,
      };

      const routedModel = ctx.llmConfig?.model?.trim();
      const fallbackModel = ctx.fallbackLlmConfig?.model?.trim();
      const attemptsRaw: Array<{ model: string; fenceOutput: boolean; useSchemaConstraints: boolean; reason: string }> = [
        {
          model: resolvedLlm.model,
          fenceOutput: args.fenceOutput,
          useSchemaConstraints: args.useSchemaConstraints,
          reason: "primary",
        },
      ];
      if (args.fenceOutput) {
        attemptsRaw.push({
          model: resolvedLlm.model,
          fenceOutput: false,
          useSchemaConstraints: args.useSchemaConstraints,
          reason: "primary_no_fence",
        });
      }
      if (routedModel && routedModel !== resolvedLlm.model) {
        attemptsRaw.push({
          model: routedModel,
          fenceOutput: false,
          useSchemaConstraints: true,
          reason: "routed_model_fallback",
        });
      }
      if (fallbackModel && fallbackModel !== resolvedLlm.model && fallbackModel !== routedModel) {
        attemptsRaw.push({
          model: fallbackModel,
          fenceOutput: false,
          useSchemaConstraints: true,
          reason: "route_fallback_model",
        });
      }

      const attempts = attemptsRaw.filter((attempt, idx, arr) => {
        const key = `${attempt.model}::${attempt.fenceOutput}::${attempt.useSchemaConstraints}`;
        return arr.findIndex((entry) => `${entry.model}::${entry.fenceOutput}::${entry.useSchemaConstraints}` === key) === idx;
      });

      let effectiveFenceOutput = args.fenceOutput;
      let effectiveUseSchemaConstraints = args.useSchemaConstraints;
      let effectiveModelId = resolvedLlm.model;
      let parsed: PythonResult | null = null;
      let stderr = "";
      const failureSummaries: string[] = [];

      for (let i = 0; i < attempts.length; i += 1) {
        const attempt = attempts[i]!;
        const payloadForAttempt: Record<string, unknown> = {
          ...pyPayload,
          model_id: attempt.model,
          fence_output: attempt.fenceOutput,
          use_schema_constraints: attempt.useSchemaConstraints,
        };
        const run = await runLangextractPython({
          pythonBin,
          timeoutMs,
          payload: payloadForAttempt,
          env: process.env,
          cwd: ctx.workspaceDir,
        });
        stderr = [stderr, run.stderr].filter(Boolean).join("\n");
        if (run.parsed.ok) {
          parsed = run.parsed;
          effectiveFenceOutput = attempt.fenceOutput;
          effectiveUseSchemaConstraints = attempt.useSchemaConstraints;
          effectiveModelId = attempt.model;
          break;
        }
        const err = String(run.parsed.error ?? "unknown extraction error");
        failureSummaries.push(`${attempt.reason}:${attempt.model}:${err}`);
        const shouldContinue = isLangextractParseLikeError(err);
        if (!shouldContinue || i === attempts.length - 1) {
          parsed = run.parsed;
          break;
        }
      }

      if (!parsed) {
        return "ERROR: langextract execution produced no result.";
      }

      if (!parsed.ok) {
        if ((parsed.error ?? "").toLowerCase().includes("failed to import langextract")) {
          return "ERROR: langextract is not installed in the runtime python environment. Install with `pip install langextract`.";
        }
        const extra = [
          parsed.error ? `error=${parsed.error}` : "",
          parsed.traceback ? `traceback=${truncateForError(parsed.traceback, 3000)}` : "",
          failureSummaries.length ? `attempts=${truncateForError(failureSummaries.join(" | "), 1500)}` : "",
          stderr.trim() ? `stderr=${truncateForError(stderr, 1500)}` : "",
        ].filter(Boolean).join("; ");
        return `ERROR: langextract extraction failed${extra ? ` (${extra})` : ""}`;
      }

      const nowIso = new Date(ctx.nowMs()).toISOString();
      const day = nowIso.slice(0, 10);
      const stamp = nowIso.replace(/[:.]/g, "-");
      const stem = sanitizeFileStem(
        args.extractionClasses.slice(0, 3).join("-") || args.promptDescription.slice(0, 40),
      );
      const defaultRelativeOutput = path.join("langextract", day, `${stamp}-${stem}.json`);
      const outputAbsPath = resolveWithinRoots({
        inputPath: args.outputPath ?? defaultRelativeOutput,
        defaultRoot: rootDir(ctx, args.outputRoot),
        roots: allowedRoots(ctx),
      });
      await fs.mkdir(path.dirname(outputAbsPath), { recursive: true });

      const outputPayload = {
        tool: "langextract_extract",
        createdAt: nowIso,
        request: {
          promptDescription: args.promptDescription,
          extractionClasses: args.extractionClasses,
          modelType: "openai",
          modelId: effectiveModelId,
          requestedModelId: resolvedLlm.model,
          modelUrl: resolvedLlm.baseUrl,
          maxWorkers: args.maxWorkers,
          extractionPasses: args.extractionPasses,
          fenceOutput: effectiveFenceOutput,
          requestedFenceOutput: args.fenceOutput,
          useSchemaConstraints: effectiveUseSchemaConstraints,
          requestedUseSchemaConstraints: args.useSchemaConstraints,
          maxResultExtractions: args.maxResultExtractions,
          timeoutMs,
        },
        source: {
          type: source.type,
          label: source.sourceLabel,
          isUrl: source.type === "document" ? source.sourceIsUrl : false,
        },
        result: parsed,
      };
      await fs.writeFile(outputAbsPath, JSON.stringify(outputPayload, null, 2), "utf8");

      const extractionRows = Array.isArray(parsed.extractions) ? parsed.extractions : [];
      const totalCount = parsed.meta?.total_extractions ?? extractionRows.length;
      const returnedCount = parsed.meta?.returned_extractions ?? extractionRows.length;

      let blackboardId: string | null = null;
      if (args.writeToBlackboard) {
        const title = args.blackboardTitle?.trim() || `LangExtract: ${args.promptDescription.slice(0, 160)}`;
        const content = [
          "LangExtract extraction complete.",
          `Source: ${source.sourceLabel}`,
          `Prompt: ${args.promptDescription}`,
          `Classes: ${args.extractionClasses.join(", ")}`,
          `Extractions: ${returnedCount}/${totalCount}${parsed.meta?.truncated ? " (truncated)" : ""}`,
          `JSON: ${outputAbsPath}`,
        ].join("\n");
        blackboardId = await writeBlackboardArtifact({
          ctx,
          title,
          content,
          attachmentPath: outputAbsPath,
          ttlMs: args.blackboardTtlMs,
          metadata: {
            tool: "langextract_extract",
            sourceLabel: source.sourceLabel,
            modelType: "openai",
            modelId: effectiveModelId,
            requestedModelId: resolvedLlm.model,
            modelUrl: resolvedLlm.baseUrl,
            totalExtractions: totalCount,
            returnedExtractions: returnedCount,
            truncated: Boolean(parsed.meta?.truncated),
          },
        });
      }

      const preview = extractionRows.slice(0, 5);
      return JSON.stringify({
        ok: true,
        source: source.sourceLabel,
        outputPath: outputAbsPath,
        extractionCount: totalCount,
        returnedCount,
        blackboardId,
        preview,
      }, null, 2);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/ENOENT/i.test(message) && /python/i.test(message)) {
        return "ERROR: python runtime not found for langextract_extract. Install python3 and langextract in the Nexus runtime environment.";
      }
      if (/Failed to import langextract/i.test(message)) {
        return "ERROR: langextract is not installed in the runtime python environment. Install with `pip install langextract`.";
      }
      return `ERROR: ${message}`;
    }
  },
});
