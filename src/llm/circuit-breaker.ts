import type { ModelRoutingMode } from "./model-router.js";
import { OpenAICompatClient, type OpenAICompatConfig } from "./openai-compat.js";

export type CircuitState = "closed" | "open" | "half_open";

const TRIP_ON_429 = (() => {
  const raw = (process.env.NEXUS_CIRCUIT_BREAKER_TRIP_ON_429 ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
})();

export type CircuitBreakerConfig = {
  /** Consecutive eligible failures before tripping open (default: 3). */
  failureThreshold?: number;
  /** How often to probe primary when open, in ms (default: 60_000). */
  recoveryProbeIntervalMs?: number;
  /** Primary provider config for health probes. */
  primaryConfig: OpenAICompatConfig;
  onStateChange?: (from: CircuitState, to: CircuitState, reason: string) => void;
  onLog?: (line: string) => void;
};

/**
 * Gateway-level circuit breaker for LLM provider health.
 *
 * Tracks consecutive failures from the primary provider and auto-switches
 * all traffic to local when a real outage is detected. Periodically probes
 * the primary to detect recovery.
 *
 * Manual dashboard override takes priority over auto state.
 */
export class LlmCircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureMs = 0;
  private lastFailureMessage = "";
  private manualMode: ModelRoutingMode | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly failureThreshold: number;
  private readonly recoveryProbeIntervalMs: number;
  private readonly primaryConfig: OpenAICompatConfig;
  private readonly onStateChange?: CircuitBreakerConfig["onStateChange"];
  private readonly onLog?: (line: string) => void;

  constructor(config: CircuitBreakerConfig) {
    this.failureThreshold = Math.max(1, config.failureThreshold ?? 3);
    this.recoveryProbeIntervalMs = Math.max(5_000, config.recoveryProbeIntervalMs ?? 60_000);
    this.primaryConfig = config.primaryConfig;
    this.onStateChange = config.onStateChange;
    this.onLog = config.onLog;
  }

  /** Record a successful LLM request. Resets failure count, closes circuit if half_open. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === "half_open") {
      this.transition("closed", "probe_success");
    }
  }

  /** Record a failed LLM request. Only circuit-eligible errors count. */
  recordFailure(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const eligible = isCircuitBreakerEligibleError(err);

    // Any failed recovery probe should move us back to open so probing can continue.
    if (this.state === "half_open") {
      this.lastFailureMs = Date.now();
      this.lastFailureMessage = message;
      if (eligible) {
        this.consecutiveFailures++;
      }
      this.onLog?.(
        `circuit_breaker_probe_failure eligible=${eligible ? "yes" : "no"} err=${message.slice(0, 200)}`,
      );
      this.transition("open", eligible ? "probe_failure" : "probe_failure_non_eligible");
      return;
    }

    if (!eligible) return;
    this.consecutiveFailures++;
    this.lastFailureMs = Date.now();
    this.lastFailureMessage = message;
    this.onLog?.(
      `circuit_breaker_failure count=${this.consecutiveFailures}/${this.failureThreshold} err=${this.lastFailureMessage.slice(0, 200)}`,
    );
    if (this.state === "closed" && this.consecutiveFailures >= this.failureThreshold) {
      this.transition("open", `${this.consecutiveFailures} consecutive failures`);
    }
  }

  /** Returns the effective model routing mode considering manual override and auto state. */
  getEffectiveMode(): ModelRoutingMode {
    if (this.manualMode !== null) return this.manualMode;
    return this.state === "closed" ? "default" : "local_only";
  }

  /** Set manual override. Pass null to return to auto mode. */
  setManualMode(mode: ModelRoutingMode | null): void {
    const prev = this.manualMode;
    this.manualMode = mode;
    this.onLog?.(`circuit_breaker_manual prev=${prev ?? "auto"} next=${mode ?? "auto"} effective=${this.getEffectiveMode()}`);
  }

  getManualMode(): ModelRoutingMode | null {
    return this.manualMode;
  }

  getState(): CircuitState {
    return this.state;
  }

  getStats(): {
    state: CircuitState;
    consecutiveFailures: number;
    lastFailureMs: number;
    lastFailureMessage: string;
    manualMode: ModelRoutingMode | null;
    effectiveMode: ModelRoutingMode;
  } {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureMs: this.lastFailureMs,
      lastFailureMessage: this.lastFailureMessage,
      manualMode: this.manualMode,
      effectiveMode: this.getEffectiveMode(),
    };
  }

  /** Stop probe timer. Call on shutdown. */
  dispose(): void {
    this.stopProbeTimer();
  }

  private transition(to: CircuitState, reason: string): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.onStateChange?.(from, to, reason);
    this.onLog?.(`circuit_breaker_transition ${from} → ${to}: ${reason} effective=${this.getEffectiveMode()}`);

    if (to === "open") {
      this.startProbeTimer();
    } else {
      this.stopProbeTimer();
    }
  }

  private startProbeTimer(): void {
    this.stopProbeTimer();
    this.probeTimer = setInterval(() => {
      void this.runProbe();
    }, this.recoveryProbeIntervalMs);
  }

  private stopProbeTimer(): void {
    if (this.probeTimer !== null) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private async runProbe(): Promise<void> {
    if (this.state !== "open") return;
    this.onLog?.("circuit_breaker_probe_start");
    this.transition("half_open", "recovery_probe");

    try {
      const client = new OpenAICompatClient(this.primaryConfig);
      await client.completeChat({
        messages: [{ role: "user", content: "ping" }],
        tools: [],
        temperature: 0,
      });
      this.onLog?.("circuit_breaker_probe_success");
      this.recordSuccess();
    } catch (err) {
      this.onLog?.(
        `circuit_breaker_probe_failure err=${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
      );
      this.recordFailure(err);
    }
  }
}

/** Determine if an error should count toward the circuit breaker threshold. */
export function isCircuitBreakerEligibleError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/LLM request timed out/i.test(message)) return true;
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(message)) {
    return true;
  }
  // Body stall is also a provider issue
  if (/llm_fetch_body_stall/i.test(message)) return true;
  const statusMatch = message.match(/LLM request failed:\s*(\d{3})\b/);
  if (!statusMatch) return false;
  const status = Number(statusMatch[1]);
  if (!Number.isFinite(status)) return false;
  return status === 408 || status === 409 || status === 425 || (status === 429 && TRIP_ON_429) || status >= 500;
}
