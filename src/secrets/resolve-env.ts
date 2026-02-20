import { parseSecretReference, resolveSecretReference, revokeSecretLease } from "./provider.js";
import type { NexusDatabase } from "../storage/database.js";

/**
 * Runtime registry of resolved env-var secrets.
 * Populated once at gateway startup via resolveEnvSecrets().
 * Consumers call getSecret(key) instead of process.env[key].
 */
const resolvedSecrets = new Map<string, string>();

/**
 * Resolve all secret references from config.secrets.env at startup.
 *
 * Follows the same pattern as resolveMcpServerEnvSecrets() in src/mcp/manager.ts:
 * - Values containing {{secret:*}} are resolved through the sidecar/broker/provider stack
 * - Plain values are stored as-is
 * - Resolution failures fail closed (throw)
 * - Leases are revoked immediately after resolution (startup one-shot)
 *
 * Must be called after DB + sidecar are ready.
 */
export async function resolveEnvSecrets(params: {
    db: NexusDatabase;
    stateDir: string;
    env: Record<string, string>;
    log: (msg: string) => void;
    nowMs?: number;
}): Promise<{ resolved: number; fromProvider: number; plain: number; skipped: number; keys: string[] }> {
    const entries = Object.entries(params.env ?? {});
    if (entries.length === 0) {
        params.log("secrets/env: no env secrets configured in config.secrets.env");
        return { resolved: 0, fromProvider: 0, plain: 0, skipped: 0, keys: [] };
    }

    const nowMs = params.nowMs ?? Date.now();
    let fromProvider = 0;
    let plain = 0;
    let skipped = 0;
    const keys: string[] = [];

    for (const [envKey, value] of entries) {
        const parsed = parseSecretReference(value);
        if (parsed !== null) {
            // Secret reference — resolve through sidecar/broker/provider stack
            try {
                const traceId = `env-secret:${envKey}:${nowMs}`;
                const resolved = await resolveSecretReference({
                    db: params.db,
                    stateDir: params.stateDir,
                    reference: value,
                    traceId,
                    actor: `gateway:env:${envKey}`,
                    nowMs,
                });
                resolvedSecrets.set(envKey, resolved.value);
                if (resolved.leaseId) {
                    revokeSecretLease({
                        db: params.db,
                        leaseId: resolved.leaseId,
                        nowMs: nowMs + 1,
                    });
                }
                fromProvider += 1;
                keys.push(envKey);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                params.log(`secrets/env: WARN ${envKey} not resolved (${message}) — key will be unavailable`);
                skipped += 1;
            }
        } else {
            // Plain value — store as-is
            resolvedSecrets.set(envKey, value);
            plain += 1;
            keys.push(envKey);
        }
    }

    params.log(
        `secrets/env: resolved ${keys.length} env secrets (${fromProvider} via provider, ${plain} plain${skipped > 0 ? `, ${skipped} skipped` : ""})`,
    );
    return { resolved: keys.length, fromProvider, plain, skipped, keys };
}

/** Get a resolved secret value. Returns undefined if not in registry. */
export function getSecret(key: string): string | undefined {
    return resolvedSecrets.get(key);
}

/** Get a secret or throw. For required secrets at call sites that cannot proceed without the value. */
export function requireSecret(key: string): string {
    const value = resolvedSecrets.get(key);
    if (value === undefined) {
        throw new Error(`required_env_secret_missing:${key}`);
    }
    return value;
}

/** List all keys currently in the resolved registry (for status/dashboard). */
export function listResolvedSecretKeys(): string[] {
    return [...resolvedSecrets.keys()].sort();
}

/**
 * Clear all resolved secrets. For testing only.
 * @internal
 */
export function clearResolvedSecretsForTests(): void {
    resolvedSecrets.clear();
}
