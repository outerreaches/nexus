const SECRET_KEY_PATTERN = /(password|passphrase|secret|token|api[_-]?key|private[_-]?key|mnemonic|seed|credential|wallet[_-]?key|client[_-]?secret|access[_-]?key)/i;
const RAW_SECRET_VALUE_PATTERNS = [
  /-----begin [a-z0-9 ]*private key-----/i,
  /\bsk-[a-z0-9]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
];
const SECRET_TEMPLATE_PATTERN = /\{\{\s*secret:[^}]+\}\}/i;
const MONETIZATION_LOCAL_PATH_PATTERN = /(\/secrets\/credentials\.json|\/monetization\/risk-policy\.json|\/monetization\/wallet-policy\.json|\/monetization\/wallet-keys\.json)/i;

function looksLikeSecretTemplate(value: string): boolean {
  return SECRET_TEMPLATE_PATTERN.test(value);
}

function looksLikeRawSecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (looksLikeSecretTemplate(trimmed)) return false;
  if (MONETIZATION_LOCAL_PATH_PATTERN.test(trimmed.replace(/\\/g, "/"))) return true;
  for (const pattern of RAW_SECRET_VALUE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

export function containsRawSecretMaterial(input: unknown): boolean {
  const visit = (value: unknown, parentKey: string | null): boolean => {
    if (typeof value === "string") {
      if (looksLikeSecretTemplate(value)) return false;
      if (parentKey && SECRET_KEY_PATTERN.test(parentKey) && value.trim().length > 0) return true;
      return looksLikeRawSecretValue(value);
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (visit(item, parentKey)) return true;
      }
      return false;
    }
    if (!value || typeof value !== "object") return false;
    for (const [rawKey, nested] of Object.entries(value as Record<string, unknown>)) {
      const key = rawKey.trim();
      if (!key) continue;
      if (visit(nested, key)) return true;
    }
    return false;
  };
  return visit(input, null);
}
