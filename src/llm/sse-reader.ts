/**
 * Server-Sent Events helpers shared by openai-compat (chat completions stream)
 * and codex-responses (OpenAI Responses API stream).
 *
 * The Responses API and chat-completions API are different at the JSON layer
 * (event-typed objects vs. delta'd choice arrays), so this module only handles
 * the byte→line→data-payload pipeline. Higher-level event interpretation
 * (tool-call accumulation, reasoning items, usage parsing) stays in each
 * client because the wire shapes don't usefully share an accumulator.
 *
 * SSE reference: https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

const DONE_SENTINEL = "[DONE]";

/**
 * Parse a complete SSE body string and return the `data:` field of each event
 * in order. Comments (lines starting with `:`) are ignored. Multi-line data
 * fields are joined with `\n` per the SSE spec. Empty payloads and the literal
 * `[DONE]` sentinel are filtered out — callers care only about real events.
 */
export function parseSseDataEvents(rawBody: string): string[] {
  const events: string[] = [];
  let current = "";
  for (const line of rawBody.split(/\r?\n/)) {
    if (line.length === 0) {
      pushIfReal(events, current);
      current = "";
      continue;
    }
    if (line.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trimStart();
    current = current.length > 0 ? `${current}\n${payload}` : payload;
  }
  pushIfReal(events, current);
  return events;
}

/**
 * Stream `data:` payloads from a fetch response body. Yields one payload per
 * SSE event. Both `\n\n` and `\r\n\r\n` event delimiters are honored.
 *
 * Inactivity / timeout / abort handling stays in the caller's loop — this is
 * a pure line-buffered decoder. The reader is released in `finally` so callers
 * can `break` early without leaking the lock.
 *
 * The optional `onChunk` is fired with each decoded UTF-8 chunk before it's
 * line-split; openai-compat's incremental text extractor uses it to surface
 * text deltas without waiting for full event boundaries.
 */
export async function* readSseDataEvents(
  body: ReadableStream<Uint8Array>,
  opts?: { onChunk?: (text: string) => void },
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let currentData = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const decoded = decoder.decode(value, { stream: true });
      if (!decoded) continue;
      opts?.onChunk?.(decoded);
      lineBuffer += decoded;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) {
          if (currentData.length > 0) {
            const trimmed = currentData.trim();
            currentData = "";
            if (trimmed && trimmed !== DONE_SENTINEL) yield trimmed;
          }
          continue;
        }
        if (line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trimStart();
        currentData = currentData.length > 0 ? `${currentData}\n${payload}` : payload;
      }
    }
    // Flush trailing decoder state and any final data fragment without a
    // terminating blank line (some servers do that on close).
    const trailing = decoder.decode();
    if (trailing) {
      lineBuffer += trailing;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        if (line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trimStart();
        currentData = currentData.length > 0 ? `${currentData}\n${payload}` : payload;
      }
    }
    if (currentData.length > 0) {
      const trimmed = currentData.trim();
      if (trimmed && trimmed !== DONE_SENTINEL) yield trimmed;
    }
  } finally {
    reader.releaseLock();
  }
}

function pushIfReal(out: string[], current: string): void {
  const trimmed = current.trim();
  if (trimmed.length === 0) return;
  if (trimmed === DONE_SENTINEL) return;
  out.push(trimmed);
}
