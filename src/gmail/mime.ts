function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function foldHeaderValue(value: string): string {
  // Keep it simple; avoid overly long single lines.
  const trimmed = value.replace(/\r?\n/g, " ").trim();
  if (trimmed.length <= 900) return trimmed;
  return trimmed.slice(0, 900);
}

export function buildRawEmail(params: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
}): { raw: string; rawBase64Url: string } {
  const headers: string[] = [];
  headers.push(`To: ${foldHeaderValue(params.to)}`);
  if (params.cc) headers.push(`Cc: ${foldHeaderValue(params.cc)}`);
  if (params.bcc) headers.push(`Bcc: ${foldHeaderValue(params.bcc)}`);
  if (params.replyTo) headers.push(`Reply-To: ${foldHeaderValue(params.replyTo)}`);
  headers.push(`Subject: ${foldHeaderValue(params.subject)}`);
  headers.push("MIME-Version: 1.0");

  const text = params.text ?? "";
  const html = params.html ?? "";

  if (html.trim()) {
    const boundary = `nexus-${Math.random().toString(16).slice(2)}-${Date.now()}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 7bit",
      "",
      text,
      "",
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: 7bit",
      "",
      html,
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const raw = `${headers.join("\r\n")}\r\n\r\n${body}`;
    return { raw, rawBase64Url: base64UrlEncode(raw) };
  }

  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: 7bit");
  const raw = `${headers.join("\r\n")}\r\n\r\n${text}\r\n`;
  return { raw, rawBase64Url: base64UrlEncode(raw) };
}

