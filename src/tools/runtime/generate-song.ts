import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../../core/tools.js";
import { getSecret } from "../../secrets/resolve-env.js";
import { resolveWithinRoots } from "../path-utils.js";
import { truncateText, withTimeout } from "../web-shared.js";

const OPENROUTER_AUDIO_GENERATIONS_ENDPOINT = "https://openrouter.ai/api/v1/audio/generations";
const LYRIA_3_PRO_MODEL = "google/lyria-3-pro-preview";
const DEFAULT_DURATION_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 120_000;

const DEFAULT_REFERER = "https://github.com/outerreaches/nexus";
const DEFAULT_TITLE = "Nexus generate_song";

type GenerateSongRequest = {
  model: typeof LYRIA_3_PRO_MODEL;
  prompt: string;
  duration_seconds: number;
  lyrics?: string;
  style?: string;
  // OpenRouter bills this model per completed song ($0.08/song), not per token.
  reference_audio?: {
    filename?: string;
    mimeType?: string;
    data: string;
  };
};

type OpenRouterAudioItem = {
  url?: string;
  audio_url?: string;
  b64_json?: string;
  audio_data?: string;
  format?: string;
  duration_seconds?: number;
};

type OpenRouterSongResponse = {
  id?: string;
  model?: string;
  created?: number;
  data?: OpenRouterAudioItem[];
  url?: string;
  audio_url?: string;
  b64_json?: string;
  audio_data?: string;
  error?: {
    message?: string;
    type?: string;
  };
};

function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".flac") return "audio/flac";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".m4a") return "audio/mp4";
  return "application/octet-stream";
}

function buildPrompt(params: { prompt: string; style?: string; lyrics?: string }): string {
  const parts: string[] = [params.prompt.trim()];
  if (params.style?.trim()) {
    parts.push(`Style: ${params.style.trim()}`);
  }
  if (params.lyrics?.trim()) {
    parts.push(`Lyrics:\n${params.lyrics.trim()}`);
  }
  return parts.join("\n\n");
}

function extractAudioResult(response: OpenRouterSongResponse): { audioUrl?: string; audioData?: string; item?: OpenRouterAudioItem } {
  const item = Array.isArray(response.data) ? response.data[0] : undefined;
  const audioUrl = item?.url ?? item?.audio_url ?? response.url ?? response.audio_url;
  const audioData = item?.b64_json ?? item?.audio_data ?? response.b64_json ?? response.audio_data;
  return { audioUrl, audioData, item };
}

export const generateSong = defineTool({
  name: "generate_song",
  description: "Generate a song from a text prompt using OpenRouter Lyria-3-Pro and return audio URL or base64 audio data.",
  parameters: z.object({
    prompt: z.string().min(1).max(4000).describe("Text description of the song to generate."),
    duration_seconds: z.number().int().min(10).max(600).default(DEFAULT_DURATION_SECONDS)
      .describe("Target song duration in seconds."),
    lyrics: z.string().max(12000).optional().describe("Optional lyrics to include in the generated song."),
    style: z.string().max(200).optional().describe("Optional music style or genre hint (e.g. synth-pop, lo-fi hip hop)."),
    reference_audio: z.string().max(4000).optional()
      .describe("Optional path to a reference audio file for style matching (absolute or under allowed roots)."),
  }),
  execute: async (args, ctx) => {
    const apiKey = (getSecret("OPENROUTER_API_KEY") ?? "").trim();
    if (!apiKey) {
      throw new Error("Missing OPENROUTER_API_KEY (required for generate_song).");
    }

    const payload: GenerateSongRequest = {
      model: LYRIA_3_PRO_MODEL,
      prompt: buildPrompt({ prompt: args.prompt, style: args.style, lyrics: args.lyrics }),
      duration_seconds: args.duration_seconds,
    };

    if (args.lyrics?.trim()) payload.lyrics = args.lyrics.trim();
    if (args.style?.trim()) payload.style = args.style.trim();

    if (args.reference_audio?.trim()) {
      const resolvedPath = resolveWithinRoots({
        inputPath: args.reference_audio,
        roots: [ctx.workspaceDir, ctx.stateDir, ctx.codeDir],
        defaultRoot: ctx.workspaceDir,
      });
      const bytes = await fs.readFile(resolvedPath);
      payload.reference_audio = {
        filename: path.basename(resolvedPath),
        mimeType: inferMimeType(resolvedPath),
        data: bytes.toString("base64"),
      };
    }

    const response = await fetch(OPENROUTER_AUDIO_GENERATIONS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": DEFAULT_REFERER,
        "X-Title": DEFAULT_TITLE,
      },
      body: JSON.stringify(payload),
      signal: withTimeout(DEFAULT_TIMEOUT_MS),
    });

    const bodyText = await response.text();
    let parsed: OpenRouterSongResponse | null = null;
    if (bodyText.trim()) {
      try {
        parsed = JSON.parse(bodyText) as OpenRouterSongResponse;
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const errorMessage = parsed?.error?.message || truncateText(bodyText || response.statusText, 1200);
      throw new Error(`OpenRouter generate_song failed (${response.status}): ${errorMessage}`);
    }

    if (!parsed) {
      throw new Error("OpenRouter generate_song returned an empty or non-JSON response.");
    }

    const { audioUrl, audioData, item } = extractAudioResult(parsed);
    if (!audioUrl && !audioData) {
      throw new Error("OpenRouter generate_song response did not include audioUrl or audioData.");
    }

    return JSON.stringify({
      audioUrl,
      audioData,
      metadata: {
        provider: "openrouter",
        model: parsed.model ?? LYRIA_3_PRO_MODEL,
        durationSeconds: item?.duration_seconds ?? args.duration_seconds,
        format: item?.format ?? null,
        songPricingUsd: 0.08,
        pricingNote: "Lyria-3-Pro on OpenRouter is billed per completed song, not per token.",
        requestId: parsed.id ?? null,
        created: parsed.created ?? null,
      },
    });
  },
});
