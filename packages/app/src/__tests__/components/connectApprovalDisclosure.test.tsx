/**
 * Connect approval screens — cost disclosure
 *
 * Both of these panels are the last checkpoint before an irreversible,
 * dApp-initiated spend, so anything the user is charged has to be on screen
 * before they can approve it. These render the REAL panels and assert the
 * disclosure, because the failure mode is silent: a missing line doesn't
 * break anything, it just means the user approved a cost they never saw.
 *
 *  1. `MintRequestPanel` previews the bytes that will actually be written on
 *     chain (sanitized, for SVG), and shows a dApp-supplied `feeRate`
 *     override, flagging it when above what the wallet would have charged.
 *  2. `SwapAcceptRequestPanel` itemizes price + enforced creator royalty +
 *     marketplace fee with a total, since the taker pays all three, and says
 *     so when the royalty could not be determined rather than implying zero.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Buffer } from "buffer";
import { ChakraProvider } from "@chakra-ui/react";
import { embeddableContentBytes } from "@app/svgSanitize";
import type { MintRequest, SwapAcceptRequest } from "@app/connect/protocol";
import type { SwapAcceptPreview } from "@app/connect/swapFlow";

const { mockPreviewSwapAccept } = vi.hoisted(() => ({
  mockPreviewSwapAccept: vi.fn(),
}));

// swapFlow's broadcasting half constructs a real Worker / hits the network at
// import time; only the read-only preview is under test here.
vi.mock("@app/connect/swapFlow", () => ({
  previewSwapAccept: mockPreviewSwapAccept,
}));

// TokenContent renders on-chain media through OPFS/electrum — irrelevant to
// the cost disclosure, and heavy.
vi.mock("@app/components/TokenContent", () => ({
  default: () => null,
}));

import MintRequestPanel from "@app/components/connect/MintRequestPanel";
import SwapAcceptRequestPanel from "@app/components/connect/SwapAcceptRequestPanel";
import { electrumStatus, feeRate } from "@app/signals";
import { ElectrumStatus } from "@app/types";

function renderPanel(ui: React.ReactElement) {
  return render(<ChakraProvider>{ui}</ChakraProvider>);
}

function mintRequest(overrides: Partial<MintRequest> = {}): MintRequest {
  return {
    protocol: "photonic-connect",
    v: 1,
    t: "mint-request",
    name: "Test NFT",
    main: { mime: "image/png", data: "aGVsbG8=" },
    ...overrides,
  };
}

const noop = () => {};

const CREATOR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

const mintProps = {
  signerAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
  locked: false,
  autoReturn: false,
  onApprove: noop,
  onReject: noop,
};

describe("MintRequestPanel — content preview", () => {
  it("previews the SANITIZED svg, not the raw bytes the dApp sent", () => {
    // What the user approves has to be what gets written on-chain:
    // `buildMintPayload` embeds `embeddableContentBytes(...)`, so the preview
    // must render exactly those bytes. A raw preview would render markup that
    // never makes it on-chain (and, for a hostile SVG, markup the sanitizer
    // exists to remove).
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="5"/></svg>';
    renderPanel(
      <MintRequestPanel
        request={mintRequest({
          main: {
            mime: "image/svg+xml",
            data: Buffer.from(svg).toString("base64"),
          },
        })}
        {...mintProps}
      />
    );

    const img = screen.getByAltText("NFT content preview") as HTMLImageElement;
    const previewed = Buffer.from(
      img.src.replace(/^data:image\/svg\+xml;base64,/, ""),
      "base64"
    ).toString();

    expect(previewed).not.toContain("<script>");
    expect(previewed).toContain("circle");
    // And it is byte-identical to what the mint payload would embed.
    expect(previewed).toBe(
      Buffer.from(
        embeddableContentBytes("image/svg+xml", new Uint8Array(Buffer.from(svg)))
      ).toString()
    );
  });

  it("leaves a non-svg image untouched", () => {
    const png = Buffer.from("hello").toString("base64");
    renderPanel(
      <MintRequestPanel
        request={mintRequest({ main: { mime: "image/png", data: png } })}
        {...mintProps}
      />
    );
    const img = screen.getByAltText("NFT content preview") as HTMLImageElement;
    expect(img.src).toBe(`data:image/png;base64,${png}`);
  });
});

describe("MintRequestPanel — fee rate disclosure", () => {
  beforeEach(() => {
    feeRate.value = 10_000;
  });

  it("says nothing about fee rate when the request doesn't override it", () => {
    renderPanel(<MintRequestPanel request={mintRequest()} {...mintProps} />);
    expect(screen.queryByText("Fee rate")).not.toBeInTheDocument();
  });

  it("shows an app-requested fee rate alongside the wallet's own", () => {
    renderPanel(
      <MintRequestPanel request={mintRequest({ feeRate: 25_000 })} {...mintProps} />
    );
    expect(screen.getByText("Fee rate")).toBeInTheDocument();
    expect(screen.getByText(/25000 photons\/byte/)).toBeInTheDocument();
    // The comparison is the point — "25000" alone means nothing to a user who
    // doesn't know what their wallet charges.
    expect(
      screen.getByText(/replacing your wallet's\s*10000 photons\/byte/)
    ).toBeInTheDocument();
  });

  it("warns when the requested rate is above the wallet's own", () => {
    renderPanel(
      <MintRequestPanel request={mintRequest({ feeRate: 25_000 })} {...mintProps} />
    );
    expect(
      screen.getByText(/asking to pay a higher network fee/)
    ).toBeInTheDocument();
  });

  it("does not warn when the requested rate is at or below the wallet's", () => {
    renderPanel(
      <MintRequestPanel request={mintRequest({ feeRate: 10_000 })} {...mintProps} />
    );
    expect(screen.getByText("Fee rate")).toBeInTheDocument();
    expect(
      screen.queryByText(/asking to pay a higher network fee/)
    ).not.toBeInTheDocument();
  });
});

function swapRequest(
  overrides: Partial<SwapAcceptRequest> = {}
): SwapAcceptRequest {
  return {
    protocol: "photonic-connect",
    v: 1,
    t: "swap-accept-request",
    psrt: "00",
    ...overrides,
  };
}

const swapProps = {
  locked: false,
  autoReturn: false,
  onApprove: noop,
  onReject: noop,
};

function preview(overrides: Partial<SwapAcceptPreview> = {}): SwapAcceptPreview {
  return { priceRxd: 10, ...overrides };
}

describe("SwapAcceptRequestPanel — cost disclosure", () => {
  beforeEach(() => {
    mockPreviewSwapAccept.mockReset();
    electrumStatus.value = ElectrumStatus.CONNECTED;
  });

  it("shows price alone when nothing is added on top", async () => {
    mockPreviewSwapAccept.mockResolvedValue(preview());
    renderPanel(<SwapAcceptRequestPanel request={swapRequest()} {...swapProps} />);

    await waitFor(() =>
      expect(screen.getByText("10 RXD")).toBeInTheDocument()
    );
    // A "Total" identical to the price would be noise.
    expect(screen.queryByText("Total")).not.toBeInTheDocument();
    expect(screen.queryByText("Creator royalty")).not.toBeInTheDocument();
  });

  it("itemizes an enforced royalty and includes it in the total", async () => {
    mockPreviewSwapAccept.mockResolvedValue(preview({ royaltyRxd: 0.5 }));
    renderPanel(<SwapAcceptRequestPanel request={swapRequest()} {...swapProps} />);

    await waitFor(() =>
      expect(screen.getByText("Creator royalty")).toBeInTheDocument()
    );
    expect(screen.getByText("0.5 RXD")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("10.5 RXD")).toBeInTheDocument();
  });

  it("adds royalty and marketplace fee together in the total", async () => {
    // Deliberately float-hostile amounts: plain `0.1 + 0.2 + 0.07` evaluates
    // to 0.37000000000000005, so this fails if the summation stops going
    // through Big. RXD prices really do carry decimals like these.
    mockPreviewSwapAccept.mockResolvedValue(
      preview({ priceRxd: 0.1, royaltyRxd: 0.2 })
    );
    renderPanel(
      <SwapAcceptRequestPanel
        request={swapRequest({ feeRxd: 0.07, feeAddress: CREATOR })}
        {...swapProps}
      />
    );

    await waitFor(() =>
      expect(screen.getByText("Marketplace fee")).toBeInTheDocument()
    );
    expect(screen.getByText("Creator royalty")).toBeInTheDocument();
    expect(screen.getByText("0.37 RXD")).toBeInTheDocument();
    expect(screen.queryByText(/0\.370000/)).not.toBeInTheDocument();
  });

  it("totals a marketplace fee even with no royalty", async () => {
    mockPreviewSwapAccept.mockResolvedValue(preview());
    renderPanel(
      <SwapAcceptRequestPanel
        request={swapRequest({ feeRxd: 0.25, feeAddress: CREATOR })}
        {...swapProps}
      />
    );

    await waitFor(() => expect(screen.getByText("Total")).toBeInTheDocument());
    expect(screen.getByText("10.25 RXD")).toBeInTheDocument();
    expect(screen.queryByText("Creator royalty")).not.toBeInTheDocument();
  });

  it("says the royalty is unknown rather than implying it is zero", async () => {
    mockPreviewSwapAccept.mockResolvedValue(preview({ royaltyUnknown: true }));
    renderPanel(<SwapAcceptRequestPanel request={swapRequest()} {...swapProps} />);

    await waitFor(() =>
      expect(
        screen.getByText(/creator royalty couldn't be checked/)
      ).toBeInTheDocument()
    );
  });
});
