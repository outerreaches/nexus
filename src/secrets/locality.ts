const DEFAULT_MONETIZATION_ONLY_PREFIXES = [
  "wallet.",
  "exchange.",
  "risk.",
  "monetization.",
];

const DEFAULT_MONETIZATION_LOCAL_PATH_PATTERNS = [
  "/secrets/credentials.json",
  "/monetization/risk-policy.json",
  "/monetization/risk.json",
  "/monetization/wallet-policy.json",
  "/monetization/wallet-keys.json",
];

function parseCsvEnv(name: string): string[] {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function getMonetizationOnlyPrefixes(): string[] {
  const configured = parseCsvEnv("NEXUS_MONETIZATION_SECRET_PREFIXES");
  return configured.length > 0 ? configured : DEFAULT_MONETIZATION_ONLY_PREFIXES;
}

function getMonetizationLocalPathPatterns(): string[] {
  const configured = parseCsvEnv("NEXUS_MONETIZATION_LOCAL_PATH_PATTERNS");
  return configured.length > 0 ? configured : DEFAULT_MONETIZATION_LOCAL_PATH_PATTERNS;
}

export function normalizeRuntimeProfile(value: string | null | undefined): string {
  return (value ?? process.env.NEXUS_RUNTIME_PROFILE ?? "").trim().toLowerCase();
}

export function isMonetizationProfile(value: string | null | undefined): boolean {
  return normalizeRuntimeProfile(value) === "monetization";
}

export function isMonetizationOnlyCredentialId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  if (!normalized) return false;
  const prefixes = getMonetizationOnlyPrefixes();
  return prefixes.some((prefix) => {
    if (normalized.startsWith(prefix)) return true;
    const slashPrefix = prefix.endsWith(".") ? `${prefix.slice(0, -1)}/` : `${prefix}/`;
    return normalized.startsWith(slashPrefix);
  });
}

export function assertCredentialLocality(params: {
  credentialId: string;
  runtimeProfile?: string | null;
  operation: string;
}): void {
  if (!isMonetizationOnlyCredentialId(params.credentialId)) return;
  if (isMonetizationProfile(params.runtimeProfile)) return;
  throw new Error(
    `credential_locality_violation:${params.operation}:${params.credentialId}:requires_monetization_profile`,
  );
}

export function isMonetizationLocalPath(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .toLowerCase();
  if (!normalized) return false;
  const patterns = getMonetizationLocalPathPatterns();
  return patterns.some((pattern) => normalized.includes(pattern));
}
