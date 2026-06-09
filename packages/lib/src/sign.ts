/**
 * Out-of-band message signing for external-wallet "connect" handshakes.
 *
 * This is the minimal signing primitive an external dApp (e.g. the
 * GlyphGalaxy wallet-connect flow, `docs/WALLET_CONNECT_SCOPE.md`) needs to
 * bind a Photonic identity without the user ever pasting their seed: the dApp
 * issues a namespaced challenge string, the wallet signs it here, and the
 * dApp verifies the signature with radiantjs `Message.verify` (which recovers
 * the signer's pubkey from the *recoverable* compact signature — no pubkey is
 * transmitted, the signature carries it).
 *
 * SECURITY — why this is safe to expose as a service:
 *   1. It ONLY ever signs through radiantjs `Message`, which prepends the
 *      "Bitcoin Signed Message" magic prefix before hashing. That prefix is
 *      what prevents this endpoint from being abused as a *transaction*
 *      signing oracle: a magic-prefixed message digest can never collide with
 *      a raw transaction sighash, so a malicious caller cannot trick the user
 *      into signing a spendable pre-image by dressing it up as a "message".
 *   2. There is NO raw-hash entry point. Callers pass a human-readable string;
 *      they cannot hand us an arbitrary 32-byte digest to sign.
 *   3. Replay/cross-dApp safety is the CALLER's responsibility: the message is
 *      expected to be namespaced + nonce-bound (e.g.
 *      `glyphgalaxy:wallet-connect:v1:<sessionId>:<nonce>`). This module is
 *      deliberately namespace-agnostic so it stays a general primitive; the
 *      UI layer is responsible for displaying the verbatim message to the user
 *      and gating on explicit, per-request approval.
 *
 * The returned signature is a base64 compact recoverable signature, byte-for-
 * byte what `Message.sign` produces and `Message.verify` consumes. Signing is
 * NON-deterministic (random k), so two signatures over the same message
 * differ; both verify.
 */
import rjs from "@radiant-core/radiantjs";

const { Message, PrivateKey } = rjs;

/**
 * Upper bound on the length of a message we are willing to sign. A connect
 * challenge is ~60 chars; this cap is pure defense-in-depth so the service
 * can never be coerced into hashing an unbounded blob. Raise deliberately if
 * a legitimate use needs longer messages.
 */
export const MAX_MESSAGE_LENGTH = 4096;

/**
 * True if `s` contains any C0 control character or DEL (0x7f). A sign-safe
 * message must not: it guarantees the UI can render the message verbatim for
 * approval and that nothing can smuggle a hidden payload past the human
 * reviewer. Implemented with `charCodeAt` rather than a regex literal so the
 * source carries no literal control bytes.
 */
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

export type SignedMessage = {
  /** P2PKH address the signature recovers to — the identity the dApp binds. */
  address: string;
  /** Compressed public key hex (informational; the sig is self-recovering). */
  pubkey: string;
  /** The exact message that was signed (echoed for the verifier). */
  message: string;
  /** base64 compact recoverable signature (radiantjs `Message` format). */
  signature: string;
};

/** Throws if `message` is not a sign-safe, displayable string. */
function assertSignableMessage(message: string): void {
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("signMessage: message must be a non-empty string");
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(
      `signMessage: message exceeds MAX_MESSAGE_LENGTH (${MAX_MESSAGE_LENGTH})`
    );
  }
  if (hasControlChars(message)) {
    throw new Error("signMessage: message contains control characters");
  }
}

/**
 * Sign `message` with a radiantjs `PrivateKey`. Returns the signature plus the
 * address/pubkey it recovers to. Prefer {@link signMessageWithWif} from app
 * code so the WIF stays scoped to a transient frame (see
 * `packages/app/src/wallet.ts::withWif`).
 */
export function signMessage(
  message: string,
  privKey: rjs.PrivateKey
): SignedMessage {
  assertSignableMessage(message);
  const signature = Message.sign(message, privKey);
  return {
    address: privKey.toAddress().toString(),
    pubkey: privKey.toPublicKey().toString(),
    message,
    signature,
  };
}

/** As {@link signMessage} but takes a WIF string. */
export function signMessageWithWif(
  message: string,
  wif: string
): SignedMessage {
  return signMessage(message, PrivateKey.fromWIF(wif));
}

/**
 * Verify a recoverable signature against a claimed address. This is the exact
 * check a verifier (server/indexer/dApp) runs: it recovers the signer pubkey
 * from `signature`, re-derives the address, and compares to `address`.
 *
 * radiantjs `Message.verify` THROWS on a malformed signature/address; this
 * wrapper normalizes every failure to `false` so callers get a clean boolean.
 */
export function verifyMessage(
  message: string,
  address: string,
  signature: string
): boolean {
  try {
    if (typeof message !== "string" || message.length === 0) return false;
    if (typeof address !== "string" || typeof signature !== "string") {
      return false;
    }
    return Message.verify(message, address, signature) === true;
  } catch {
    return false;
  }
}
