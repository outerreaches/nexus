import assert from "node:assert/strict";
import test from "node:test";

import { parseSseDataEvents, readSseDataEvents } from "./sse-reader.js";

test("parseSseDataEvents extracts payloads and ignores comments + [DONE]", () => {
  const body = [
    ": keepalive",
    "data: {\"a\":1}",
    "",
    "data: {\"a\":2}",
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  assert.deepEqual(parseSseDataEvents(body), [`{"a":1}`, `{"a":2}`]);
});

test("parseSseDataEvents joins multi-line data fields with newline", () => {
  const body = ["data: line1", "data: line2", "", ""].join("\n");
  assert.deepEqual(parseSseDataEvents(body), ["line1\nline2"]);
});

test("parseSseDataEvents tolerates CRLF line endings", () => {
  const body = ["data: hello", "", "data: world", "", ""].join("\r\n");
  assert.deepEqual(parseSseDataEvents(body), ["hello", "world"]);
});

test("parseSseDataEvents flushes trailing data without final blank line", () => {
  const body = "data: only\n";
  assert.deepEqual(parseSseDataEvents(body), ["only"]);
});

function streamFromString(text: string, chunkSize: number = 16): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const slice = bytes.slice(offset, Math.min(offset + chunkSize, bytes.length));
      offset += slice.length;
      controller.enqueue(slice);
    },
  });
}

test("readSseDataEvents yields payloads in order across small chunks", async () => {
  const body = [
    ": keepalive",
    "data: {\"a\":1}",
    "",
    "data: chunk-split",
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const collected: string[] = [];
  for await (const ev of readSseDataEvents(streamFromString(body, 4))) {
    collected.push(ev);
  }
  assert.deepEqual(collected, [`{"a":1}`, "chunk-split"]);
});

test("readSseDataEvents fires onChunk before yielding events", async () => {
  const body = "data: a\n\ndata: b\n\n";
  const chunks: string[] = [];
  const events: string[] = [];
  for await (const ev of readSseDataEvents(streamFromString(body, 100), {
    onChunk: (text) => chunks.push(text),
  })) {
    events.push(ev);
  }
  assert.deepEqual(events, ["a", "b"]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], body);
});

test("readSseDataEvents flushes trailing data on stream close without blank line", async () => {
  const body = "data: tail\n";
  const collected: string[] = [];
  for await (const ev of readSseDataEvents(streamFromString(body, 64))) {
    collected.push(ev);
  }
  assert.deepEqual(collected, ["tail"]);
});

test("readSseDataEvents emits a final event with no trailing newline", async () => {
  // Servers that close without a final \n must not lose the terminal event
  // (for codex-responses this is typically response.completed / usage).
  const body = 'data: {"a":1}\n\ndata: {"final":true}';
  const collected: string[] = [];
  for await (const ev of readSseDataEvents(streamFromString(body, 1024))) {
    collected.push(ev);
  }
  assert.deepEqual(collected, [`{"a":1}`, `{"final":true}`]);
});

test("readSseDataEvents emits an unterminated final event across small chunks", async () => {
  const body = 'data: {"final":true}';
  const collected: string[] = [];
  for await (const ev of readSseDataEvents(streamFromString(body, 3))) {
    collected.push(ev);
  }
  assert.deepEqual(collected, [`{"final":true}`]);
});

test("readSseDataEvents handles a multibyte split in the unterminated final line", async () => {
  const body = 'data: {"msg":"héllo→world"}';
  const collected: string[] = [];
  for await (const ev of readSseDataEvents(streamFromString(body, 5))) {
    collected.push(ev);
  }
  assert.deepEqual(collected, ['{"msg":"héllo→world"}']);
});
