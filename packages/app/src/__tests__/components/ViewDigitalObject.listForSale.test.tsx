/**
 * ViewDigitalObject — "List for sale" entry point
 *
 * Regression guard for the general atomic-swap listing affordance on the NFT
 * detail page. Verifies:
 *   1. A plain (non-royalty) NFT shows a "List for sale" button and NOT the
 *      enforced-royalty button.
 *   2. Clicking it navigates to /swap with the token pre-selected as the
 *      offered asset — `{ state: { offerGlyphRef: nft.ref } }` — the exact
 *      contract Swap.tsx consumes (Swap.tsx:428-443), identical to the WAVE
 *      Names "List for Sale" flow.
 *   3. A royalty NFT shows ONLY the enforced-royalty path (no plain
 *      "List for sale"), so a royalty cannot be bypassed by a plain swap.
 *
 * Renders the REAL ViewDigitalObject; only leaf/heavy deps are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { ChakraProvider } from "@chakra-ui/react";
import { MemoryRouter } from "react-router-dom";
import ViewDigitalObject from "../../components/ViewDigitalObject";

// Hoisted handles referenced inside the (hoisted) vi.mock factories below.
const { mockNavigate, mockFetchGlyph, live } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockFetchGlyph: vi.fn(),
  live: { current: [undefined, undefined, undefined, undefined] as unknown[] },
}));

// useLiveQuery returns our fixture tuple [nft, txo, author, container] directly,
// so the real db is never touched by this component.
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => live.current,
}));

// Spy on navigation; keep MemoryRouter / useLocation real.
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("@app/signals", () => ({
  wallet: { value: { locked: false } },
  openModal: { value: null },
}));

// The plain "List for sale" handler re-decodes the token from chain before
// allowing a royalty-free swap (belt-and-suspenders against a stale row that's
// missing its on-chain royalty). Stub the worker so the pre-check is
// controllable; importing the real Electrum module would spin up a Web Worker.
vi.mock("@app/electrum/Electrum", () => ({
  electrumWorker: { value: { fetchGlyph: mockFetchGlyph } },
}));

vi.mock("@app/layouts/ViewPanelLayout", () => ({
  useViewPanelContext: () => [false, vi.fn()],
}));

vi.mock("@app/network/createExplorerUrl", () => ({
  default: () => "https://explorer.example/tx",
}));

// Heavy / db-touching children rendered to inert stubs. Factories must be
// inline literals (vi.mock is hoisted above any const declarations).
vi.mock("@app/components/TokenContent", () => ({ default: () => null }));
vi.mock("@app/components/SendDigitalObject", () => ({ default: () => null }));
vi.mock("@app/components/DownloadLink", () => ({ default: () => null }));
vi.mock("@app/components/PageHeader", () => ({ default: () => null }));
vi.mock("@app/components/TokenDetails", () => ({ default: () => null }));
vi.mock("../../components/MeltDigitalObject", () => ({ default: () => null }));
vi.mock("../../components/RoyaltyListModal", () => ({ default: () => null }));
vi.mock("../../components/TxSuccessModal", () => ({ default: () => null }));
vi.mock("../../components/EditDigitalObject", () => ({ default: () => null }));

const TXID = "a".repeat(64);
const txo = { id: 1, txid: TXID, vout: 0, value: 1, height: 100, spent: 0 };

const plainNft = {
  id: 1,
  ref: "ref-plain-nft",
  name: "Plain NFT",
  p: [],
  type: undefined,
  swapPending: 0,
  lastTxoId: 1,
};

const royaltyNft = {
  ...plainNft,
  ref: "ref-royalty-nft",
  name: "Royalty NFT",
  royalty: { address: "1Royalty", amount: 100 },
};

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <MemoryRouter>
    <ChakraProvider>
      <I18nProvider i18n={i18n}>{children}</I18nProvider>
    </ChakraProvider>
  </MemoryRouter>
);

const renderObject = async (sref: string) => {
  await act(async () => {
    render(
      <Wrapper>
        <ViewDigitalObject sref={sref} />
      </Wrapper>
    );
  });
};

describe("ViewDigitalObject — List for sale", () => {
  beforeEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
    vi.clearAllMocks();
    // Default: the on-chain re-decode confirms no royalty, so the plain swap is
    // allowed through. Individual tests override to exercise the guard.
    mockFetchGlyph.mockResolvedValue({ ref: "ref-plain-nft" });
    // jsdom has no matchMedia; Chakra's toast (framer-motion) needs it.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows 'List for sale' for a non-royalty NFT (and not the royalty path)", async () => {
    live.current = [plainNft, txo, undefined, undefined];
    await renderObject(plainNft.ref);

    expect(screen.getByText("List for sale")).toBeInTheDocument();
    expect(screen.queryByText("List with enforced royalty")).toBeNull();
  });

  it("navigates to /swap with the token pre-selected when clicked (chain confirms no royalty)", async () => {
    live.current = [plainNft, txo, undefined, undefined];
    mockFetchGlyph.mockResolvedValue({ ref: "ref-plain-nft" }); // no royalty
    await renderObject(plainNft.ref);

    await act(async () => {
      fireEvent.click(screen.getByText("List for sale"));
    });

    expect(mockFetchGlyph).toHaveBeenCalledWith("ref-plain-nft");
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
    expect(mockNavigate).toHaveBeenCalledWith("/swap", {
      state: { offerGlyphRef: "ref-plain-nft" },
    });
  });

  it("blocks the plain swap when the chain re-decode reveals a royalty", async () => {
    live.current = [plainNft, txo, undefined, undefined];
    // Stale row had no royalty, but the on-chain payload does — the guard must
    // refuse the royalty-free swap so the creator isn't silently stripped.
    mockFetchGlyph.mockResolvedValue({
      ref: "ref-plain-nft",
      royalty: { address: "1Royalty", bps: 500 },
    });
    await renderObject(plainNft.ref);

    await act(async () => {
      fireEvent.click(screen.getByText("List for sale"));
    });

    expect(mockFetchGlyph).toHaveBeenCalledWith("ref-plain-nft");
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("still allows the plain swap if the on-chain pre-check fails (don't block offline)", async () => {
    live.current = [plainNft, txo, undefined, undefined];
    mockFetchGlyph.mockRejectedValue(new Error("network down"));
    await renderObject(plainNft.ref);

    await act(async () => {
      fireEvent.click(screen.getByText("List for sale"));
    });

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
    expect(mockNavigate).toHaveBeenCalledWith("/swap", {
      state: { offerGlyphRef: "ref-plain-nft" },
    });
  });

  it("offers ONLY the enforced-royalty path for a royalty NFT (no plain swap)", async () => {
    live.current = [royaltyNft, txo, undefined, undefined];
    await renderObject(royaltyNft.ref);

    expect(screen.getByText("List with enforced royalty")).toBeInTheDocument();
    expect(screen.queryByText("List for sale")).toBeNull();
  });

  it("shows a loading state while the live query is unresolved", async () => {
    // undefined result === query not yet resolved
    live.current = undefined as unknown as unknown[];
    await renderObject("ref-loading");

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("List for sale")).toBeNull();
  });

  it("shows 'Token not found' when the query resolved but the token is missing", async () => {
    // resolved (array) but no nft/txo
    live.current = [undefined, undefined, undefined, undefined];
    await renderObject("ref-missing");

    expect(screen.getByText("Token not found")).toBeInTheDocument();
    expect(screen.queryByText("List for sale")).toBeNull();
  });
});
