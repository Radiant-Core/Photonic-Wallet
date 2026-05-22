/**
 * SecretBytes — a Uint8Array wrapper that can be deterministically zeroed.
 *
 * Purpose: replace the bare JS strings that previously held the wallet
 * mnemonic, WIF, and swap-WIF in `wallet.value`. JS strings are immutable
 * and cannot be overwritten, so once the unlocked session held a 12/24-word
 * string the only way to drop it was to lose every reference and hope the
 * GC compacted the heap. With `SecretBytes` the canonical store is a byte
 * buffer that `wipe()` overwrites with zeros before nulling the reference.
 *
 * Strings still appear *transiently* in two places that this design cannot
 * close:
 *   1. Unlock decryption — `entropyToMnemonic` and `PrivateKey.toString()`
 *      both produce JS strings. They live for the duration of `unlockWallet`
 *      while we encode them to bytes and then go out of scope.
 *   2. Signing — `radiantjs.PrivateKey.fromString(wif)` needs a string. We
 *      materialise it inside the callback passed to `with*` and let it fall
 *      out of scope immediately after.
 *
 * Both windows are now bounded to a single function frame instead of the
 * entire unlocked session, which is the strictest improvement reachable
 * without rewriting upstream libraries.
 *
 * Threat model: this protects against a forensic memory dump *taken after
 * the wallet is locked* — the heap will no longer contain a recoverable
 * mnemonic/WIF buffer. It does *not* defend against an attacker reading
 * memory while the wallet is unlocked, nor against XSS during an unlocked
 * session — the bytes must be readable for signing to work.
 */
export class SecretBytes {
  private buf: Uint8Array | null;

  /**
   * Take ownership of an existing `Uint8Array`. The caller must not retain
   * the original reference — we hold the only pointer so `wipe()` can clear
   * it. If you need to keep the caller's array intact, use
   * `SecretBytes.fromCopy(bytes)`.
   */
  constructor(bytes: Uint8Array) {
    this.buf = bytes;
  }

  /** Copy the input so the caller's array is unaffected by future `wipe()`. */
  static fromCopy(bytes: Uint8Array): SecretBytes {
    return new SecretBytes(new Uint8Array(bytes));
  }

  /**
   * Encode a string as UTF-8 bytes. The input string still exists in JS
   * heap until GC — only use this at the boundary where a string is
   * unavoidable (e.g. mnemonic decryption, `privKey.toString()`).
   */
  static fromString(s: string): SecretBytes {
    return new SecretBytes(new TextEncoder().encode(s));
  }

  /** Whether `wipe()` has been called. */
  get isWiped(): boolean {
    return this.buf === null;
  }

  /** Byte length of the underlying buffer, or 0 if wiped. */
  get length(): number {
    return this.buf?.length ?? 0;
  }

  /**
   * Run a callback with a transient view of the bytes. The bytes are NOT
   * zeroed afterward — call `wipe()` explicitly when the secret should be
   * destroyed. Throws if already wiped.
   *
   * Prefer this over `toBytes()` because it makes the bytes' lifetime
   * lexically obvious.
   */
  use<T>(cb: (bytes: Uint8Array) => T): T {
    if (!this.buf) throw new Error("SecretBytes already wiped");
    return cb(this.buf);
  }

  /**
   * Decode the bytes back to a UTF-8 string for a single operation. The
   * returned string lives until the caller drops the reference — use it
   * inline (`PrivateKey.fromString(wif.toString())`) rather than storing.
   */
  toString(): string {
    if (!this.buf) throw new Error("SecretBytes already wiped");
    return new TextDecoder().decode(this.buf);
  }

  /**
   * Overwrite the buffer with zeros and drop the reference. Idempotent —
   * subsequent calls are no-ops.
   */
  wipe(): void {
    if (this.buf) {
      this.buf.fill(0);
      this.buf = null;
    }
  }
}

/**
 * Convenience: ensure the optional `SecretBytes` is wiped, then return
 * `undefined` for assignment to signal state.
 *
 *   wallet.value = { ...wallet.value, wif: disposeSecret(wallet.value.wif) };
 */
export function disposeSecret(s: SecretBytes | undefined): undefined {
  s?.wipe();
  return undefined;
}
