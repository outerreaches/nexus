import path from "node:path";

const EXT_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".csv": "text/csv",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".bin": "application/octet-stream",
};

const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "text/csv": ".csv",
  "application/json": ".json",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/x-tar": ".tar",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "application/octet-stream": ".bin",
};

export function mimeFromExtension(ext: string): string {
  const key = ext.trim().toLowerCase();
  return EXT_TO_MIME[key] ?? "application/octet-stream";
}

export function extensionFromMime(mimeType?: string): string {
  if (!mimeType) return "";
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIME_TO_EXT[base] ?? "";
}

export function detectMimeType(filePath: string, fallbackMimeType?: string): string {
  if (fallbackMimeType && fallbackMimeType.trim().length > 0) {
    return fallbackMimeType.split(";")[0]!.trim().toLowerCase();
  }
  const ext = path.extname(filePath).toLowerCase();
  return mimeFromExtension(ext);
}

export function isImageMimeType(mimeType: string): boolean {
  return /^image\//i.test(mimeType);
}

const OPENROUTER_INLINE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export function isOpenRouterInlineImageMimeType(mimeType: string): boolean {
  return OPENROUTER_INLINE_IMAGE_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

export function sanitizeTelegramFilename(name: string): string {
  const trimmed = name.trim();
  const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_");
  return sanitized.length > 0 ? sanitized : "file";
}
