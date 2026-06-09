/**
 * End-to-end Phase A handshake — proves cross-repo compatibility with the
 * GlyphGalaxy wallet-connect flow (`docs/WALLET_CONNECT_SCOPE.md`).
 *
 * Simulates the full round trip:
 *   game: build namespaced challenge -> SignRequest -> base64url deep-link
 *   Photonic: parseSignRequest -> sign (via @lib/sign) -> SignResult
 *   game: parse result -> verify with radiantjs `Message.verify`
 *          (the SAME verifier the scope's `verifyWalletConnect` runs)
 *
 * The signing key here stands in for a Photonic wallet's spending key; in the
 * app the WIF is supplied transiently via `withWif`.
 */
import { it, expect, describe } from "vitest";
import rjs from "@radiant-core/radiantjs";
import { signMessageWithWif } from "@lib/sign";
import {
  parseSignRequest,
  encodeReqParam,
  encodeSignResult,
  buildSignResult,
  type SignRequest,
} from "../protocol";

const { Message, PrivateKey } = rjs;

// --- game side (GlyphGalaxy) ------------------------------------------------
const WALLET_CONNECT_VERSION = "v1";
function walletConnectChallenge(sessionId: string, nonce: string): string {
  return `glyphgalaxy:wallet-connect:${WALLET_CONNECT_VERSION}:${sessionId}:${nonce}`;
}
function verifyWalletConnect(
  address: string,
  sessionId: string,
  nonce: string,
  signature: string
): boolean {
  try {
    return Message.verify(
      walletConnectChallenge(sessionId, nonce),
      address,
      signature
    );
  } catch {
    return false;
  }
}

describe("Phase A wallet-connect handshake (cross-repo)", () => {
  const sessionId = "sess-9f52ebf";
  const nonce = "0123456789abcdef0123456789abcdef";

  it("round-trips: a Photonic signature satisfies the game's verifier", () => {
    // game: build the request and serialize it into a deep-link param
    const challenge = walletConnectChallenge(sessionId, nonce);
    const key = new PrivateKey();
    const claimedAddress = key.toAddress().toString();
    const request: SignRequest = {
      protocol: "photonic-connect",
      v: 1,
      t: "sign-request",
      challenge,
      id: "conn-1",
      origin: "https://app.glyphgalaxy.com",
      address: claimedAddress,
    };
    const param = encodeReqParam(request);

    // Photonic: parse, sign, build result
    const parsed = parseSignRequest(param);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.challenge).toBe(challenge);

    const signed = signMessageWithWif(parsed.request.challenge, key.toWIF());
    const result = buildSignResult(parsed.request, signed);
    const wire = encodeSignResult(result);

    // game: parse the result and verify with its own verifier
    const back = JSON.parse(wire);
    expect(back.id).toBe("conn-1");
    expect(back.address).toBe(claimedAddress);
    expect(
      verifyWalletConnect(back.address, sessionId, nonce, back.signature)
    ).toBe(true);
  });

  it("a signature for one nonce does not verify against another (replay)", () => {
    const key = new PrivateKey();
    const address = key.toAddress().toString();
    const signed = signMessageWithWif(
      walletConnectChallenge(sessionId, nonce),
      key.toWIF()
    );
    // server bound a DIFFERENT nonce -> must fail
    expect(
      verifyWalletConnect(
        address,
        sessionId,
        "ffffffffffffffff",
        signed.signature
      )
    ).toBe(false);
    // different session id -> must fail
    expect(
      verifyWalletConnect(address, "other-session", nonce, signed.signature)
    ).toBe(false);
  });

  it("a different wallet's signature does not bind the claimed address", () => {
    const claimed = new PrivateKey().toAddress().toString();
    const attacker = new PrivateKey();
    const signed = signMessageWithWif(
      walletConnectChallenge(sessionId, nonce),
      attacker.toWIF()
    );
    // attacker signs the right challenge but recovers to attacker's address,
    // so verification against the claimed address fails.
    expect(
      verifyWalletConnect(claimed, sessionId, nonce, signed.signature)
    ).toBe(false);
  });

  it("a plot-auth signature cannot be replayed as a connect proof (namespace)", () => {
    const key = new PrivateKey();
    const address = key.toAddress().toString();
    // sign the OTHER namespace the scope uses (plot-auth)
    const plotAuth = signMessageWithWif(
      `glyphgalaxy:plot-auth:v2:${nonce}`,
      key.toWIF()
    );
    expect(
      verifyWalletConnect(address, sessionId, nonce, plotAuth.signature)
    ).toBe(false);
  });
});
