import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormHelperText,
  FormLabel,
  HStack,
  Input,
  NumberInput,
  NumberInputField,
  Select,
  Textarea,
  useToast,
} from "@chakra-ui/react";
import { MdKey } from "react-icons/md";
import {
  createMarketAction,
  createCategoricalAction,
  createScalarAction,
  supportedOutcomeCounts,
} from "@app/predict/predict";
import { electrumWorker } from "@app/electrum/Electrum";
import { wallet } from "@app/signals";
import { withWif } from "@app/wallet";
import { publicKeyHexFromWif } from "@lib/wallet";
import { MAX_QUESTION_BYTES } from "radiantswap";

type MarketKind = "binary" | "categorical" | "scalar";

export default function PredictCreate() {
  const toast = useToast();
  const navigate = useNavigate();
  const [question, setQuestion] = useState("");
  const [expiry, setExpiry] = useState("");
  const [grace, setGrace] = useState("4320"); // ~30 days of blocks
  const [height, setHeight] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [useCommittee, setUseCommittee] = useState(false);
  const [committeeKeys, setCommitteeKeys] = useState("");
  const [threshold, setThreshold] = useState("2");
  const [kind, setKind] = useState<MarketKind>("binary");
  const [showAdvanced, setShowAdvanced] = useState(false);
  // optimistic-oracle (MarketOpt) terms — binary markets only
  const [useOptimistic, setUseOptimistic] = useState(false);
  const [bondRxd, setBondRxd] = useState("0.1");
  const [liveness, setLiveness] = useState("36");
  // Optional off-chain reference market (Polymarket) — binary markets only
  const [oddsRef, setOddsRef] = useState("");
  // categorical
  const [outcomeCount, setOutcomeCount] = useState(String(supportedOutcomeCounts[0] ?? 3));
  const [outcomeLabels, setOutcomeLabels] = useState("");
  // scalar
  const [scalarMin, setScalarMin] = useState("0");
  const [scalarMax, setScalarMax] = useState("100");
  const [scalarBins, setScalarBins] = useState(String(supportedOutcomeCounts[0] ?? 3));
  const [scalarUnit, setScalarUnit] = useState("");

  // Append this wallet's own compressed pubkey to the committee list (deduped).
  // The user is usually a committee member; this saves them deriving it by hand.
  const addMyKey = () => {
    let pk = "";
    try {
      pk = withWif(publicKeyHexFromWif) ?? "";
    } catch {
      pk = "";
    }
    if (!pk) {
      toast({
        title: "Unlock your wallet to use your key",
        status: "warning",
      });
      return;
    }
    setCommitteeKeys((prev) => {
      const lines = prev
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.includes(pk)) return prev;
      return [...lines, pk].join("\n");
    });
  };

  useEffect(() => {
    electrumWorker.value
      .getBlockHeight()
      .then((h) => {
        setHeight(h);
        setExpiry((cur) => cur || String(h + 4320));
      })
      .catch(() => undefined);
  }, []);

  const submit = async () => {
    const e = parseInt(expiry, 10);
    const g = parseInt(grace, 10);
    if (!question.trim() || Buffer.byteLength(question, "utf8") > MAX_QUESTION_BYTES) {
      toast({
        title: `Question must be 1–${MAX_QUESTION_BYTES} bytes`,
        status: "warning",
      });
      return;
    }
    if (!Number.isInteger(e) || (height !== null && e <= height)) {
      toast({ title: "Expiry must be a future block height", status: "warning" });
      return;
    }
    if (!Number.isInteger(g) || g < 1) {
      toast({ title: "Grace must be at least 1 block", status: "warning" });
      return;
    }
    let committee: { keys: string[]; threshold: number } | undefined;
    if (useCommittee) {
      const keys = committeeKeys
        .split("\n")
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);
      const th = parseInt(threshold, 10);
      if (
        keys.length < 1 ||
        keys.length > 3 ||
        keys.some((k) => !/^0[23][0-9a-f]{64}$/.test(k))
      ) {
        toast({
          title: "Committee needs 1–3 compressed pubkeys (66 hex chars each)",
          status: "warning",
        });
        return;
      }
      if (!Number.isInteger(th) || th < 1 || th > keys.length) {
        toast({ title: "Threshold must be 1…number of keys", status: "warning" });
        return;
      }
      committee = { keys, threshold: th };
    }
    let optimistic: { bond: number; liveness: number } | undefined;
    if (kind === "binary" && useOptimistic) {
      const bond = Math.round(parseFloat(bondRxd) * 100_000_000);
      const lv = parseInt(liveness, 10);
      if (!Number.isFinite(bond) || bond < 546) {
        toast({ title: "Proposer bond must be at least 546 photons", status: "warning" });
        return;
      }
      if (!Number.isInteger(lv) || lv < 1 || lv > 65535) {
        toast({ title: "Challenge window must be 1…65535 blocks", status: "warning" });
        return;
      }
      optimistic = { bond, liveness: lv };
    }
    // per-kind validation
    let labels: string[] = [];
    if (kind === "categorical") {
      const K = parseInt(outcomeCount, 10);
      labels = outcomeLabels
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (labels.length !== K) {
        toast({ title: `Enter exactly ${K} outcome labels (one per line)`, status: "warning" });
        return;
      }
    }
    let smin = 0;
    let smax = 0;
    let sbins = 0;
    if (kind === "scalar") {
      smin = parseFloat(scalarMin);
      smax = parseFloat(scalarMax);
      sbins = parseInt(scalarBins, 10);
      if (!Number.isFinite(smin) || !Number.isFinite(smax) || smax <= smin) {
        toast({ title: "Scalar range needs max > min", status: "warning" });
        return;
      }
    }

    setBusy(true);
    try {
      let createdTxid: string;
      let route = "m";
      if (kind === "binary") {
        const t = await createMarketAction({
          question: question.trim(),
          expiry: e,
          grace: g,
          committee,
          optimistic,
          oddsRef: oddsRef.trim() || undefined,
        });
        createdTxid = t.createTxid;
      } else if (kind === "categorical") {
        const t = await createCategoricalAction({
          question: question.trim(),
          expiry: e,
          grace: g,
          outcomes: parseInt(outcomeCount, 10),
          labels,
          committee,
        });
        createdTxid = t.createTxid;
        route = "cat";
      } else {
        const t = await createScalarAction({
          question: question.trim(),
          expiry: e,
          grace: g,
          min: smin,
          max: smax,
          bins: sbins,
          unit: scalarUnit.trim() || undefined,
          committee,
        });
        createdTxid = t.createTxid;
        route = "cat";
      }
      toast({ title: "Market created", status: "success" });
      navigate(`/predict/${route}/${createdTxid}`);
    } catch (err) {
      toast({
        title: "Create failed",
        description: (err as Error).message,
        status: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box mx={{ base: 2, md: 4 }} maxW="2xl">
      <Alert status="info" mb={6} borderRadius="md">
        <AlertIcon />
        By default this wallet's key becomes the market's 1-of-1 resolution
        oracle (you can set an N-of-M committee below). The oracle must resolve
        the outcome after the event; if it never does, anyone can revert the
        market after expiry + grace and all complete sets remain reclaimable.
      </Alert>

      <FormControl mb={3}>
        <Checkbox
          isChecked={showAdvanced}
          onChange={(e) => {
            setShowAdvanced(e.target.checked);
            if (!e.target.checked) setKind("binary");
          }}
        >
          Show advanced market types (categorical / scalar)
        </Checkbox>
      </FormControl>

      {showAdvanced && (
        <FormControl mb={4}>
          <FormLabel>Market type</FormLabel>
          <Select value={kind} onChange={(e) => setKind(e.target.value as MarketKind)}>
            <option value="binary">Binary (YES / NO)</option>
            <option value="categorical">Categorical (K outcomes)</option>
            <option value="scalar">Scalar (numeric range, bucketed)</option>
          </Select>
        </FormControl>
      )}

      {kind !== "binary" && (
        <Alert status="warning" mb={4} borderRadius="md">
          <AlertIcon />
          Advanced market type. You can create, mint, settle, redeem and merge it in this wallet,
          but there is no peer-to-peer order book or market discovery for it yet — only binary
          markets are fully tradeable and discoverable.
        </Alert>
      )}

      <FormControl mb={4} isRequired>
        <FormLabel>Question</FormLabel>
        <Input
          placeholder={
            kind === "scalar"
              ? "What will the RXD price be on 2026-12-31?"
              : kind === "categorical"
              ? "Who wins the 2026 election?"
              : "Will RXD ≥ $1 by 2026-12-31?"
          }
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <FormHelperText>
          {kind === "binary"
            ? "A clear, binary YES/NO question."
            : kind === "categorical"
            ? "A question with mutually-exclusive outcomes (exactly one wins)."
            : "A numeric question; the range below is split into buckets."}
        </FormHelperText>
      </FormControl>

      {kind === "binary" && (
        <FormControl mb={4}>
          <FormLabel>Reference market (optional)</FormLabel>
          <Input
            placeholder="Polymarket link or slug, e.g. poly:will-rxd-reach-1-dollar"
            value={oddsRef}
            onChange={(e) => setOddsRef(e.target.value)}
          />
          <FormHelperText>
            Link an equivalent Polymarket market. Its implied YES% is shown as an
            off-chain <b>reference</b> when your on-chain order book is empty — it
            is not the tradeable price. Stored in the market's on-chain beacon so
            everyone who opens the market sees it.
          </FormHelperText>
        </FormControl>
      )}

      {kind === "categorical" && (
        <>
          <FormControl mb={4} isRequired maxW="40">
            <FormLabel>Outcomes</FormLabel>
            <Select value={outcomeCount} onChange={(e) => setOutcomeCount(e.target.value)}>
              {supportedOutcomeCounts.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
            <FormHelperText>Supported outcome counts.</FormHelperText>
          </FormControl>
          <FormControl mb={4} isRequired>
            <FormLabel>Outcome labels (one per line)</FormLabel>
            <Textarea
              rows={Math.min(parseInt(outcomeCount, 10) || 3, 12)}
              placeholder={"Alice\nBob\nCarol"}
              value={outcomeLabels}
              onChange={(e) => setOutcomeLabels(e.target.value)}
            />
            <FormHelperText>
              Exactly {outcomeCount} mutually-exclusive outcomes; exactly one resolves as the winner.
            </FormHelperText>
          </FormControl>
        </>
      )}

      {kind === "scalar" && (
        <>
          <HStack mb={4} spacing={4} align="start">
            <FormControl isRequired>
              <FormLabel>Min</FormLabel>
              <NumberInput value={scalarMin} onChange={(v) => setScalarMin(v)}>
                <NumberInputField />
              </NumberInput>
            </FormControl>
            <FormControl isRequired>
              <FormLabel>Max</FormLabel>
              <NumberInput value={scalarMax} onChange={(v) => setScalarMax(v)}>
                <NumberInputField />
              </NumberInput>
            </FormControl>
            <FormControl isRequired maxW="32">
              <FormLabel>Buckets</FormLabel>
              <Select value={scalarBins} onChange={(e) => setScalarBins(e.target.value)}>
                {supportedOutcomeCounts.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
            </FormControl>
          </HStack>
          <FormControl mb={4} maxW="40">
            <FormLabel>Unit (optional)</FormLabel>
            <Input placeholder="$, %, pts…" value={scalarUnit} onChange={(e) => setScalarUnit(e.target.value)} />
            <FormHelperText>
              The range is split into {scalarBins} equal buckets; resolution picks the bucket
              containing the observed value.
            </FormHelperText>
          </FormControl>
        </>
      )}

      <FormControl mb={4} isRequired>
        <FormLabel>Expiry (block height)</FormLabel>
        <NumberInput value={expiry} onChange={(v) => setExpiry(v)} min={1}>
          <NumberInputField />
        </NumberInput>
        <FormHelperText>
          Resolve after the event, before expiry + grace.
          {height !== null && ` Current height: ${height.toLocaleString()}.`}
        </FormHelperText>
      </FormControl>

      <FormControl mb={4} isRequired>
        <FormLabel>Grace (blocks)</FormLabel>
        <NumberInput value={grace} onChange={(v) => setGrace(v)} min={1}>
          <NumberInputField />
        </NumberInput>
        <FormHelperText>
          After expiry + grace an unresolved market becomes revertible
          (merge-only collateral reclaim).
        </FormHelperText>
      </FormControl>

      <FormControl mb={4}>
        <Checkbox
          isChecked={useCommittee}
          onChange={(e) => setUseCommittee(e.target.checked)}
        >
          Use an oracle committee instead of this wallet's key
        </Checkbox>
      </FormControl>

      {useCommittee && (
        <>
          <FormControl mb={4} isRequired>
            <HStack justify="space-between" align="center" mb={2}>
              <FormLabel mb={0}>
                Committee member pubkeys (slot order, one per line)
              </FormLabel>
              <Button
                size="xs"
                variant="link"
                colorScheme="brand"
                leftIcon={<MdKey />}
                onClick={addMyKey}
                isDisabled={wallet.value.locked}
              >
                Use my key
              </Button>
            </HStack>
            <Textarea
              fontFamily="mono"
              fontSize="sm"
              rows={3}
              placeholder={"02… (member A)\n03… (member B)\n02… (member C)"}
              value={committeeKeys}
              onChange={(e) => setCommitteeKeys(e.target.value)}
            />
            <FormHelperText>
              1–3 compressed secp256k1 pubkeys. Slot order is consensus-binding
              — keep it for resolution. Save these keys: the chain stores only
              their hash.
            </FormHelperText>
          </FormControl>
          <FormControl mb={4} isRequired maxW="40">
            <FormLabel>Threshold</FormLabel>
            <Select value={threshold} onChange={(e) => setThreshold(e.target.value)}>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </Select>
          </FormControl>
        </>
      )}

      {kind === "binary" && (
        <FormControl mb={4}>
          <Checkbox
            isChecked={useOptimistic}
            onChange={(e) => setUseOptimistic(e.target.checked)}
          >
            Optimistic resolution (anyone can propose the outcome; bonded, with a challenge window)
          </Checkbox>
        </FormControl>
      )}

      {kind === "binary" && useOptimistic && (
        <>
          <Alert status="info" mb={4} borderRadius="md">
            <AlertIcon />
            After expiry, anyone may propose YES/NO by locking the bond. The oracle
            {useCommittee ? " committee" : " (this wallet)"} can override within the challenge
            window — slashing the bond — otherwise anyone finalizes the proposal afterwards and the
            bond is returned to the proposer.
          </Alert>
          <HStack mb={4} spacing={4} align="start">
            <FormControl isRequired>
              <FormLabel>Proposer bond (RXD)</FormLabel>
              <NumberInput value={bondRxd} onChange={(v) => setBondRxd(v)} min={0}>
                <NumberInputField />
              </NumberInput>
              <FormHelperText>Locked by a proposer; ≥ 546 photons.</FormHelperText>
            </FormControl>
            <FormControl isRequired maxW="56">
              <FormLabel>Challenge window (blocks)</FormLabel>
              <NumberInput value={liveness} onChange={(v) => setLiveness(v)} min={1} max={65535}>
                <NumberInputField />
              </NumberInput>
              <FormHelperText>Override window, 1…65535.</FormHelperText>
            </FormControl>
          </HStack>
        </>
      )}

      <Button variant="primary" onClick={submit} isLoading={busy}>
        Create Market
      </Button>
    </Box>
  );
}
