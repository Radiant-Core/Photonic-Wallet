/**
 * Trust & transparency UI for prediction markets.
 *
 * These components answer the user's real question — "how do I know the resolved outcome is
 * honest?" — by surfacing, in plain language, exactly what the protocol guarantees cryptographically
 * (collateral solvency, anti-theft, reclaimable complete sets) versus what rests on trusting the
 * resolver (the actual YES/NO call). See {@link ./trustModel} for the pure classification logic.
 */
import { ReactNode } from "react";
import {
  Badge,
  Box,
  Flex,
  Text,
  Tooltip,
  type BadgeProps,
} from "@chakra-ui/react";
import { WarningTwoIcon, LockIcon } from "@chakra-ui/icons";
import Photons from "@app/components/Photons";
import {
  challengeBlocksRemaining,
  proposalConfirmations,
  type LiveMarket,
  type TrackedMarket,
} from "@app/predict/predict";
import { Status } from "radiantswap";
import {
  oracleTrust,
  bondAdequacy,
  formatRatioPct,
  type OracleTrust,
} from "@app/predict/trustModel";
import { blocksToDuration, blockEta } from "@app/predict/time";
import { NEON } from "@app/predict/ui";

/** Tooltip/explainer text for a classified oracle. Honest about the optimistic special cases: the
 *  override authority may be a single key (soloWatchdog), and override is bounded by finalization,
 *  not by the challenge window; "lowest trust" is only claimed when the guard isn't weak. */
const tip = (tr: OracleTrust): string => {
  if (tr.kind === "optimistic") {
    const guard = tr.soloWatchdog ? "a single operator key" : "a watchdog committee";
    const lead = tr.caution
      ? "Anyone can propose the outcome after expiry by locking a bond"
      : "Lowest trust of the three: anyone can propose the outcome after expiry by locking a bond";
    return `${lead}; ${guard} can override a wrong proposal before it is finalized, slashing the bond.`;
  }
  if (tr.kind === "committee")
    return "A fixed committee resolves this market. A colluding threshold of members could declare a wrong outcome — but cannot touch collateral.";
  return "A single operator key decides the outcome. They cannot touch your collateral, but they alone call the result — trust accordingly.";
};

/** At-a-glance "how trusted is the resolver" chip, derived from the on-chain oracle descriptor.
 *  Pass `pool` (collateral value) on the detail page so a thin optimistic bond downgrades the chip. */
export function OracleTrustBadge({
  t,
  pool,
  withTooltip = true,
  ...rest
}: { t: TrackedMarket; pool?: number; withTooltip?: boolean } & BadgeProps) {
  const tr = oracleTrust(t, { pool });
  const badge = (
    <Badge
      colorScheme={tr.scheme}
      variant={tr.caution ? "solid" : "subtle"}
      display="inline-flex"
      alignItems="center"
      gap={1}
      {...rest}
    >
      {tr.caution && <WarningTwoIcon boxSize="0.7em" />}
      {tr.label}
    </Badge>
  );
  return withTooltip ? (
    <Tooltip label={tip(tr)} hasArrow placement="top" fontSize="xs" maxW="xs">
      {badge}
    </Tooltip>
  ) : (
    badge
  );
}

/** Short hex display of a 20-byte proposer pubkey-hash, tagging the wallet's own proposals. */
export function ProposerTag({
  pkh,
  isYou = false,
}: {
  pkh: Uint8Array | Buffer | string;
  isYou?: boolean;
}) {
  const hex =
    typeof pkh === "string"
      ? pkh
      : Buffer.from(pkh as Uint8Array).toString("hex");
  const short = hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex;
  return (
    <Text as="span" fontFamily="mono" fontSize="xs" color="whiteAlpha.700">
      {short}
      {isYou && (
        <Badge ml={2} colorScheme="teal" variant="subtle" fontSize="0.6rem">
          you
        </Badge>
      )}
    </Text>
  );
}

/**
 * The bond-to-pool ratio for an optimistic market, with a thin-bond warning. A false proposal is
 * profitable when the proposer's winning-side payoff exceeds the bond they'd lose to an override,
 * so a bond that's small relative to the collateral pool barely deters one. Heuristic only — not
 * consensus-enforced (a covenant floor is specced in docs/HONESTY_ROADMAP.md).
 */
export function BondAdequacyNote({ bond, pool }: { bond: number; pool: number }) {
  const { ratio, level } = bondAdequacy(bond, pool);
  const pctStr = formatRatioPct(ratio);
  if (level === "ok") {
    return (
      <Text fontSize="xs" color="whiteAlpha.600">
        Proposer bond is <b>{pctStr}</b> of the collateral pool — a false proposal risks a
        meaningful stake.
      </Text>
    );
  }
  const weak = level === "weak";
  return (
    <Flex
      align="flex-start"
      gap={2}
      fontSize="xs"
      color={weak ? "orange.300" : "yellow.300"}
    >
      <WarningTwoIcon mt="2px" boxSize="0.85em" flexShrink={0} />
      <Text>
        {weak ? "Weak" : "Thin"} proposer bond — only <b>{pctStr}</b> of the collateral pool.
        A dishonest proposer risks little relative to what's at stake; weigh the resolver's
        reputation before trading.
      </Text>
    </Flex>
  );
}

/** Lifecycle strip for an optimistic market: Open → Challenge (proposed) → Resolved, current lit. */
export function ResolutionTimeline({
  t,
  live,
}: {
  t: TrackedMarket;
  live: LiveMarket;
}) {
  const s = live.state.status;
  const proposed = s === Status.PROPOSED_YES || s === Status.PROPOSED_NO;
  const disputed = s === Status.DISPUTED_YES || s === Status.DISPUTED_NO;
  const resolved =
    s === Status.RESOLVED_YES ||
    s === Status.RESOLVED_NO ||
    s === Status.REVERTED;
  // Open → Challenge/Dispute (proposed or disputed) → Resolved.
  const current = resolved ? 2 : proposed || disputed ? 1 : 0;
  const liveness = t.optimistic?.liveness ?? 0;
  const conf = proposalConfirmations(live);
  const left = challengeBlocksRemaining(t, live);

  const challengeSub = disputed
    ? left > 0
      ? `disputed · ≈${blocksToDuration(left)} to timeout`
      : "disputed · timeoutable"
    : proposed
    ? left > 0
      ? `${conf}/${liveness} · ≈${blocksToDuration(left)} left`
      : "finalizable now"
    : `${liveness} blk window`;

  const stages = [
    { label: "Open", sub: "bets" },
    { label: disputed ? "Disputed" : "Challenge", sub: challengeSub },
    { label: "Resolved", sub: resolved ? "final" : "payout" },
  ];

  return (
    <Flex align="center" gap={0} fontFamily="mono" mb={1}>
      {stages.map((stage, i) => {
        const done = i < current;
        const here = i === current;
        const color = done || here ? NEON.yes : "whiteAlpha.300";
        return (
          <Flex key={i} align="center" flex={i < stages.length - 1 ? 1 : "0 0 auto"}>
            <Flex direction="column" align="center" minW="72px">
              <Box
                w="10px"
                h="10px"
                borderRadius="full"
                bg={here ? NEON.yes : done ? "rgba(70,230,160,0.5)" : "whiteAlpha.200"}
                boxShadow={here ? `0 0 12px ${NEON.yes}` : "none"}
              />
              <Text fontSize="xs" color={color} mt={1} fontWeight={here ? "bold" : "normal"}>
                {stage.label}
              </Text>
              <Text fontSize="0.6rem" color="whiteAlpha.500" noOfLines={1}>
                {stage.sub}
              </Text>
            </Flex>
            {i < stages.length - 1 && (
              <Box
                flex={1}
                h="2px"
                mx={1}
                mb={4}
                bg={i < current ? "rgba(70,230,160,0.5)" : "whiteAlpha.200"}
              />
            )}
          </Flex>
        );
      })}
    </Flex>
  );
}

/**
 * Plain-language "how this market resolves & your recourse" panel — the centrepiece of the trust
 * story. States exactly who can call the outcome, what it costs them to lie, and what the trader's
 * fallback is if the resolver goes dark. `live` (current height + pool) sharpens the estimates when
 * available (detail page); omit it on the hub.
 */
export function TrustPanel({
  t,
  live,
  height: heightProp,
  terminal: terminalProp,
}: {
  t: TrackedMarket;
  live?: LiveMarket | null;
  /** Current height for ETA, when the caller has no binary LiveMarket (categorical/scalar page). */
  height?: number | null;
  /** Explicit terminal state for non-binary markets (whose status enum / outcome aren't YES/NO). */
  terminal?: { reverted: boolean; label?: string };
}) {
  const height = live?.height ?? heightProp ?? null;
  const pool = live?.market.satoshis ?? null;
  const tr = oracleTrust(t, { pool: pool ?? undefined });
  const revertibleAt = t.expiry + t.grace;
  const revertEta =
    height != null ? ` (${blockEta(height, revertibleAt)})` : "";
  const expiryEta = height != null ? ` (${blockEta(height, t.expiry)})` : "";

  // Once terminal, the propose/challenge/revert copy below is future-tense fiction — show what
  // actually happened instead, and drop the "if the resolver never acts" recourse line. Binary
  // markets derive this from the live status; other shapes pass `terminal` explicitly.
  const status = live?.state.status;
  const binaryTerminal =
    status === Status.RESOLVED_YES ||
    status === Status.RESOLVED_NO ||
    status === Status.REVERTED;
  const isTerminal = terminalProp != null || binaryTerminal;

  let body: ReactNode;
  if (isTerminal) {
    const reverted = terminalProp
      ? terminalProp.reverted
      : status === Status.REVERTED;
    const label =
      terminalProp?.label ?? (status === Status.RESOLVED_YES ? "YES" : "NO");
    body = reverted ? (
      <Text>
        This market was <b>reverted</b> without a resolution — every complete set is reclaimable via{" "}
        <b>Merge</b>; a single side has no redemption value.
      </Text>
    ) : (
      <Text>
        This market <b>resolved {label}</b>. Winning shares redeem 1:1 against the collateral pool;
        the losing side has no value.
      </Text>
    );
  } else if (tr.kind === "optimistic" && t.optimistic) {
    const livenessTime = blocksToDuration(t.optimistic.liveness);
    const guard = tr.soloWatchdog ? "a single operator key" : "the committee";
    body = (
      <>
        <Text>
          After expiry (block {t.expiry.toLocaleString()}
          {expiryEta}) <b>anyone</b> may propose the outcome by locking a bond of{" "}
          <Photons value={t.optimistic.bond} />. There is then a{" "}
          <b>{t.optimistic.liveness}-block (≈{livenessTime})</b> challenge window before it can be
          finalized; until then {guard} can override a wrong proposal and slash the bond. If no one
          disputes, it finalizes as proposed and the bond is returned.
        </Text>
        {pool != null && (
          <Box mt={2}>
            <BondAdequacyNote bond={t.optimistic.bond} pool={pool} />
          </Box>
        )}
      </>
    );
  } else if (tr.kind === "committee") {
    body = (
      <Text>
        A <b>{tr.n ? `${tr.threshold}-of-${tr.n}` : `${tr.threshold}-signature`}</b> committee
        resolves this market. A colluding threshold of members could declare a wrong outcome, but
        they cannot steal collateral, double-resolve, or mint shares. There is no on-chain bond on
        the committee — trust rests on the members' integrity.
      </Text>
    );
  } else {
    body = (
      <Text>
        A <b>single operator key</b> decides this market's outcome. They cannot touch your
        collateral or mint shares, but they alone call the result with no bond at stake — only
        trade if you trust that operator.
      </Text>
    );
  }

  return (
    <Box
      borderRadius="xl"
      border="1px solid"
      borderColor={tr.caution ? "rgba(236, 201, 75, 0.35)" : NEON.border}
      bg="rgba(10, 20, 17, 0.5)"
      p={4}
      maxW="2xl"
      fontSize="sm"
      color="whiteAlpha.800"
    >
      <Flex align="center" gap={2} mb={2}>
        <Text fontWeight="bold" color="whiteAlpha.900">
          How this resolves &amp; your recourse
        </Text>
        <OracleTrustBadge t={t} pool={pool ?? undefined} />
      </Flex>
      {body}
      {!isTerminal && (
        <Text mt={3} color="whiteAlpha.600">
          Recourse: if the resolver never acts, <b>Revert</b> is permissionless once the chain passes
          expiry + grace (block {revertibleAt.toLocaleString()}
          {revertEta}); every complete set then stays reclaimable via <b>Merge</b>.
        </Text>
      )}
      <Flex align="center" gap={2} mt={3} color="whiteAlpha.500" fontSize="xs">
        <LockIcon boxSize="0.85em" color={NEON.yesText} />
        <Text>
          Guaranteed on-chain regardless of the resolver: collateral is fully backed 1:1, shares
          can't be minted without locking RXD, and complete sets are always reclaimable.
        </Text>
      </Flex>
    </Box>
  );
}
