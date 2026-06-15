import { describe, it, expect } from "vitest";
import {
  oracleThreshold,
  oracleTrust,
  bondAdequacy,
  formatRatioPct,
  BOND_OK_RATIO,
  BOND_THIN_RATIO,
} from "../../predict/trustModel";
import {
  SECONDS_PER_BLOCK,
  blocksUntil,
  blocksToDuration,
  blockEta,
} from "../../predict/time";

describe("block↔time helpers", () => {
  it("uses RXD 5-minute target spacing", () => {
    expect(SECONDS_PER_BLOCK).toBe(300);
  });

  it("clamps blocksUntil at zero", () => {
    expect(blocksUntil(100, 130)).toBe(30);
    expect(blocksUntil(130, 100)).toBe(0);
    expect(blocksUntil(100, 100)).toBe(0);
  });

  it("humanises block counts coarsely", () => {
    expect(blocksToDuration(0)).toBe("now");
    expect(blocksToDuration(-5)).toBe("now");
    expect(blocksToDuration(1)).toBe("5m"); // 1 block = 5 min
    expect(blocksToDuration(12)).toBe("1h"); // 12 blocks = 60 min
    expect(blocksToDuration(13)).toBe("1h 5m");
    expect(blocksToDuration(288)).toBe("24h"); // 288 blocks = 24h, still hours bucket (<48h)
    expect(blocksToDuration(576)).toBe("2d"); // 576 blocks = 48h → days bucket
  });

  it("formats an ETA behind ≈", () => {
    expect(blockEta(100, 100)).toBe("now");
    expect(blockEta(100, 112)).toBe("≈1h");
  });
});

describe("oracleThreshold", () => {
  it("reads the descriptor threshold byte (hex)", () => {
    expect(oracleThreshold({ oracle: "02" + "ab".repeat(32) })).toBe(2);
    expect(oracleThreshold({ oracle: "03" + "00".repeat(32) })).toBe(3);
  });
  it("defaults to 1 on a missing/zero/garbage descriptor", () => {
    expect(oracleThreshold({ oracle: "" })).toBe(1);
    expect(oracleThreshold({ oracle: "00" + "00".repeat(32) })).toBe(1);
    expect(oracleThreshold({ oracle: "zz" })).toBe(1);
  });
});

describe("oracleTrust", () => {
  it("classes a well-bonded multi-key optimistic market as the strongest (bonded)", () => {
    const tr = oracleTrust({
      oracle: "02" + "0".repeat(64),
      committeeKeys: ["a", "b", "c"],
      optimistic: { bond: 1, liveness: 6 },
    });
    expect(tr.kind).toBe("optimistic");
    expect(tr.strength).toBe(2);
    expect(tr.caution).toBe(false);
    expect(tr.soloWatchdog).toBe(false);
    expect(tr.label).toBe("Bonded optimistic");
  });

  it("flags a threshold-1 optimistic market as a solo-watchdog (caution)", () => {
    // The override authority is the same threshold descriptor, so a 1-sig optimistic market has a
    // single key as its only dispute backstop — must NOT rank above a real committee.
    const tr = oracleTrust({
      oracle: "01" + "0".repeat(64),
      optimistic: { bond: 1, liveness: 6 },
    });
    expect(tr.kind).toBe("optimistic");
    expect(tr.soloWatchdog).toBe(true);
    expect(tr.caution).toBe(true);
    expect(tr.strength).toBe(1);
    expect(tr.label).toBe("Bonded · solo guard");
  });

  it("downgrades a multi-key optimistic market with a thin bond when the pool is known", () => {
    const tr = oracleTrust(
      {
        oracle: "02" + "0".repeat(64),
        committeeKeys: ["a", "b", "c"],
        optimistic: { bond: 1, liveness: 6 },
      },
      { pool: 1000 } // 0.1% → weak bond
    );
    expect(tr.kind).toBe("optimistic");
    expect(tr.caution).toBe(true);
    expect(tr.strength).toBe(1);
    expect(tr.label).toBe("Bonded · thin bond");
  });

  it("classifies a discovered optimistic market via optimisticHint (no full terms)", () => {
    // Multi-sig discovered market (no committeeKeys in the beacon) → strongest; bond axis unknown.
    const strong = oracleTrust({ oracle: "02" + "0".repeat(64), optimisticHint: true });
    expect(strong.kind).toBe("optimistic");
    expect(strong.caution).toBe(false);
    expect(strong.label).toBe("Bonded optimistic");
    // The default-created (solo) optimistic market still cautions even when only hinted.
    const solo = oracleTrust({ oracle: "01" + "0".repeat(64), optimisticHint: true });
    expect(solo.soloWatchdog).toBe(true);
    expect(solo.caution).toBe(true);
  });

  it("classes a 2-of-3 as a committee, no caution", () => {
    const tr = oracleTrust({ oracle: "02" + "0".repeat(64), committeeKeys: ["a", "b", "c"] });
    expect(tr.kind).toBe("committee");
    expect(tr.n).toBe(3);
    expect(tr.label).toBe("2-of-3 committee");
    expect(tr.caution).toBe(false);
  });

  it("classes a 2-sig committee with unknown N", () => {
    const tr = oracleTrust({ oracle: "02" + "0".repeat(64) });
    expect(tr.label).toBe("2-sig committee");
    expect(tr.n).toBeNull();
  });

  it("flags a single-signature classic market as caution (single operator)", () => {
    const tr = oracleTrust({ oracle: "01" + "0".repeat(64) });
    expect(tr.kind).toBe("solo");
    expect(tr.strength).toBe(0);
    expect(tr.caution).toBe(true);
    expect(tr.label).toBe("Single operator");
  });

  it("labels a 1-of-N (>1) as a 1-of-N oracle but still cautions", () => {
    const tr = oracleTrust({ oracle: "01" + "0".repeat(64), committeeKeys: ["a", "b", "c"] });
    expect(tr.label).toBe("1-of-3 oracle");
    expect(tr.caution).toBe(true);
  });
});

describe("bondAdequacy", () => {
  it("rates a bond ≥10% of the pool as ok", () => {
    expect(bondAdequacy(10, 100).level).toBe("ok");
    expect(bondAdequacy(BOND_OK_RATIO * 1000, 1000).level).toBe("ok");
  });
  it("rates 2–10% as thin", () => {
    expect(bondAdequacy(5, 100).level).toBe("thin");
    expect(bondAdequacy(BOND_THIN_RATIO * 1000, 1000).level).toBe("thin");
  });
  it("rates <2% as weak", () => {
    expect(bondAdequacy(1, 100).level).toBe("weak");
    expect(bondAdequacy(0, 100).level).toBe("weak");
  });
  it("treats an empty/unknown pool as ratio 0 (weak)", () => {
    const a = bondAdequacy(1000, 0);
    expect(a.ratio).toBe(0);
    expect(a.level).toBe("weak");
  });
});

describe("formatRatioPct", () => {
  it("keeps a decimal for small ratios, rounds larger ones", () => {
    expect(formatRatioPct(0)).toBe("0%");
    expect(formatRatioPct(0.012)).toBe("1.2%");
    expect(formatRatioPct(0.25)).toBe("25%");
  });
  it("never renders 10.0% for a sub-10% (thin) ratio — floors, not rounds", () => {
    // 9.97% must not display as "10.0%" inside a thin-bond warning (10% is the OK floor).
    expect(formatRatioPct(0.0997)).toBe("9.9%");
    expect(formatRatioPct(0.0999)).toBe("9.9%");
  });
});
