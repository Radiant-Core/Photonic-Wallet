import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContractType } from "@app/types";

// Mock the heavy collaborators so the test exercises ONLY the retry / circuit-
// breaker wiring in RXDWorker (shared verbatim by FT/NFT).
const { updateTXOsMock, setStatusMock, setErrorMock } = vi.hoisted(() => ({
  updateTXOsMock: vi.fn(),
  setStatusMock: vi.fn(),
  setErrorMock: vi.fn(),
}));

vi.mock("@app/electrum/worker/updateTxos", () => ({
  buildUpdateTXOs: () => updateTXOsMock,
}));
vi.mock("@app/electrum/worker/setSubscriptionStatus", () => ({
  default: setStatusMock,
  setSubscriptionError: setErrorMock,
}));
vi.mock("@app/electrum/worker/consolidationCheck", () => ({
  consolidationCheck: vi.fn(),
}));
vi.mock("@app/utxos", () => ({ updateRxdBalances: vi.fn() }));

import { RXDWorker } from "@app/electrum/worker/RXD";

const SH = "deadbeef".repeat(8);

function makeWorker() {
  const w = new RXDWorker({ active: true } as never, {} as never);
  // Skip register() (it subscribes over a socket); set the fields manualSync uses.
  (w as unknown as { scriptHash: string }).scriptHash = SH;
  (w as unknown as { address: string }).address = "1xxx";
  return w;
}

describe("RXDWorker retry circuit breaker", () => {
  beforeEach(() => {
    updateTXOsMock.mockReset();
    setStatusMock.mockReset();
    setErrorMock.mockReset();
  });

  it("trips the breaker (surfaces an error sync state) only after repeated failures", async () => {
    updateTXOsMock.mockRejectedValue(new Error("boom")); // every sync fails
    const w = makeWorker();

    await w.manualSync(); // failure 1
    await w.manualSync(); // failure 2
    expect(setErrorMock).not.toHaveBeenCalled(); // below threshold: no error yet

    await w.manualSync(); // failure 3 -> threshold
    expect(setErrorMock).toHaveBeenCalledTimes(1);
    expect(setErrorMock).toHaveBeenCalledWith(SH, ContractType.RXD);

    // Never falsely reports a successful sync while failing.
    expect(setStatusMock).not.toHaveBeenCalled();
  });

  it("a success resets the breaker so a later single failure does not re-trip", async () => {
    const w = makeWorker();

    // Trip it.
    updateTXOsMock.mockRejectedValue(new Error("boom"));
    await w.manualSync();
    await w.manualSync();
    await w.manualSync();
    expect(setErrorMock).toHaveBeenCalledTimes(1);

    // Recover: a successful sync marks status done (no error) and resets streak.
    updateTXOsMock.mockResolvedValue({
      added: [],
      confs: new Map(),
      conflict: new Map(),
      spent: [],
    });
    await w.manualSync();
    expect(setStatusMock).toHaveBeenLastCalledWith(
      SH,
      "",
      false,
      ContractType.RXD
    );

    // One fresh failure must NOT immediately re-trip (streak was reset to 0).
    updateTXOsMock.mockRejectedValue(new Error("boom"));
    await w.manualSync();
    expect(setErrorMock).toHaveBeenCalledTimes(1); // still just the first trip
  });
});
