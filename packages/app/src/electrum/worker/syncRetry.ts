/**
 * Per-subscription retry governor for the electrum sync workers (RXD/FT/NFT).
 *
 * Why this exists: each worker's onSubscriptionReceived re-queues the status and
 * retries on ANY failure. With a fixed delay and no ceiling, a persistent error
 * — a server throttle ("excessive resource usage"), a transient DB error, an
 * offline socket — turned into an infinite, resource-burning loop that also
 * never surfaced to the UI (sync.done stayed false → an indefinite "syncing"
 * spinner). See the TransactionInactiveError and rxindexer rate-limiter
 * incidents.
 *
 * This governor does NOT give up (a wallet must recover on its own when the
 * server comes back). Instead it:
 *   - backs off exponentially, capped, so a sustained outage is polled slowly
 *     instead of hammered every few seconds, and
 *   - "trips" after a few consecutive failures, which the caller uses to mark
 *     the subscription errored so the UI stops showing an indefinite spinner.
 * A single success resets everything.
 */

/** First retry delay, and the unit the exponential backoff multiplies. */
export const SYNC_RETRY_BASE_MS = 3000;
/** Backoff ceiling — a sustained outage is retried at most this often. */
export const SYNC_RETRY_MAX_MS = 60000;
/** Consecutive failures before the breaker trips (caller surfaces an error). */
export const SYNC_BREAKER_THRESHOLD = 3;

export class SyncRetry {
  private failures = 0;

  constructor(
    private readonly baseMs: number = SYNC_RETRY_BASE_MS,
    private readonly maxMs: number = SYNC_RETRY_MAX_MS,
    private readonly threshold: number = SYNC_BREAKER_THRESHOLD
  ) {}

  /** Consecutive failures since the last success. */
  get consecutiveFailures(): number {
    return this.failures;
  }

  /**
   * True once consecutive failures reach the breaker threshold. The caller
   * surfaces an error sync state (stops the spinner) while still retrying.
   */
  get tripped(): boolean {
    return this.failures >= this.threshold;
  }

  /** A success clears the failure streak and the tripped state. */
  reset(): void {
    this.failures = 0;
  }

  /**
   * Record a failure and return the delay (ms) to wait before the next retry.
   * Exponential in the failure count, capped at maxMs:
   * 3s, 6s, 12s, 24s, 48s, 60s, 60s, …
   */
  fail(): number {
    this.failures += 1;
    return this.delayMs();
  }

  /** The current backoff delay for the present failure count (no mutation). */
  delayMs(): number {
    // Clamp the exponent so 2 ** steps can never overflow on a long outage.
    const steps = Math.min(Math.max(this.failures - 1, 0), 20);
    return Math.min(this.baseMs * 2 ** steps, this.maxMs);
  }
}
