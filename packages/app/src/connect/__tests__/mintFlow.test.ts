/**
 * Unit tests for `../mintFlow`'s pure payload-building logic
 * (`buildMintPayload`). The broadcasting half (`mintFromRequest`) touches
 * `db`/`electrumWorker`/wallet signals and is exercised end-to-end via the
 * connect UI rather than mocked here — this file covers the one piece that
 * is pure and security-relevant: turning dApp-controlled content into a safe
 * on-chain payload (size enforcement, SVG sanitization).
 */
import { describe, expect, it, vi } from "vitest";
import { Buffer } from "buffer";
import { GLYPH_NFT } from "@lib/protocols";
import { mintEmbedMaxBytes } from "@app/config.json";
import type { MintRequest } from "@app/connect/protocol";

// `mintFlow.ts` also exports the async `mintFromRequest`, which imports
// `@app/electrum/Electrum` (constructs a real Worker at module load time —
// unmockable via the default `@app/db` stub in setup.ts, same reason
// `rxdRetry.test.ts` mocks `@app/utxos`) and `@app/utxos`. Neither is
// exercised here — only the pure `buildMintPayload` — so both are stubbed to
// keep this file's import graph side-effect-free.
vi.mock("@app/electrum/Electrum", () => ({
  electrumWorker: { value: {} },
}));
vi.mock("@app/utxos", () => ({ updateRxdBalances: vi.fn() }));

import { buildMintPayload, MintRequestError } from "../mintFlow";

const CONNECT_PROTOCOL = "photonic-connect" as const;
const CONNECT_VERSION = 1 as const;

function baseRequest(overrides: Partial<MintRequest> = {}): MintRequest {
  return {
    protocol: CONNECT_PROTOCOL,
    v: CONNECT_VERSION,
    t: "mint-request",
    name: "My NFT",
    main: { mime: "image/png", data: Buffer.from("hello").toString("base64") },
    ...overrides,
  };
}

describe("buildMintPayload", () => {
  it("builds a minimal immutable NFT payload from an embedded file", () => {
    const payload = buildMintPayload(baseRequest());
    expect(payload.v).toBe(2);
    expect(payload.p).toEqual([GLYPH_NFT]);
    expect(payload.name).toBe("My NFT");
    expect(payload.desc).toBeUndefined();
    expect(payload.license).toBeUndefined();
    expect(payload.attrs).toBeUndefined();
    expect((payload.main as { t: string; b: Uint8Array }).t).toBe("image/png");
    expect(
      Buffer.from((payload.main as { t: string; b: Uint8Array }).b).toString()
    ).toBe("hello");
  });

  it("folds description, license, and attrs into the payload", () => {
    const payload = buildMintPayload(
      baseRequest({
        description: "A test item",
        license: "CC0",
        attrs: { rarity: "rare", power: 7 },
      })
    );
    expect(payload.desc).toBe("A test item");
    expect(payload.license).toBe("CC0");
    expect(payload.attrs).toEqual({ rarity: "rare", power: 7 });
  });

  it("builds a remote-pointer payload from a url main", () => {
    const payload = buildMintPayload(
      baseRequest({ main: { mime: "image/png", url: "https://realm.rxd/a.png" } })
    );
    expect(payload.main).toEqual({ t: "image/png", u: "https://realm.rxd/a.png" });
  });

  it("throws MintRequestError when embedded content exceeds the on-chain limit", () => {
    const oversized = Buffer.alloc(mintEmbedMaxBytes + 1, 1).toString("base64");
    expect(() =>
      buildMintPayload(baseRequest({ main: { mime: "image/png", data: oversized } }))
    ).toThrowError(MintRequestError);
  });

  it("accepts content right at the size limit", () => {
    const atLimit = Buffer.alloc(mintEmbedMaxBytes, 1).toString("base64");
    expect(() =>
      buildMintPayload(baseRequest({ main: { mime: "image/png", data: atLimit } }))
    ).not.toThrow();
  });

  it("sanitizes SVG content declared with the svg mime type", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const payload = buildMintPayload(
      baseRequest({
        main: {
          mime: "image/svg+xml",
          data: Buffer.from(svg).toString("base64"),
        },
      })
    );
    const bytes = (payload.main as { t: string; b: Uint8Array }).b;
    const text = Buffer.from(bytes).toString("utf8");
    expect(text).not.toContain("<script");
  });

  it("sanitizes SVG content detected by sniffing, even under a different mime", () => {
    // No mime allow-list entry lets this through mislabeled in practice
    // (protocol.ts restricts mime to the allow-list already), but the
    // sniff-based sanitization is defense-in-depth if that ever changes.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const payload = buildMintPayload(
      baseRequest({
        main: { mime: "image/svg+xml", data: Buffer.from(svg).toString("base64") },
      })
    );
    const bytes = (payload.main as { t: string; b: Uint8Array }).b;
    expect(Buffer.from(bytes).toString("utf8")).not.toContain("<script");
  });

  it("decodes base64url content the same as standard base64", () => {
    const raw = Buffer.from([0xfb, 0xff, 0xfe]); // encodes with +/ in standard base64
    const b64url = raw
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const payload = buildMintPayload(
      baseRequest({ main: { mime: "image/png", data: b64url } })
    );
    const bytes = (payload.main as { t: string; b: Uint8Array }).b;
    expect(Buffer.from(bytes)).toEqual(raw);
  });
});
