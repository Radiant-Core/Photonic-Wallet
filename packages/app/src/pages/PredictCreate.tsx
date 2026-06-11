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
  Input,
  NumberInput,
  NumberInputField,
  Select,
  Textarea,
  useToast,
} from "@chakra-ui/react";
import { createMarketAction } from "@app/predict/predict";
import { electrumWorker } from "@app/electrum/Electrum";
import { MAX_QUESTION_BYTES } from "radiantswap";

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
    setBusy(true);
    try {
      const t = await createMarketAction({
        question: question.trim(),
        expiry: e,
        grace: g,
        committee,
      });
      toast({ title: "Market created", status: "success" });
      navigate(`/predict/m/${t.createTxid}`);
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

      <FormControl mb={4} isRequired>
        <FormLabel>Question</FormLabel>
        <Input
          placeholder="Will RXD ≥ $1 by 2026-12-31?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <FormHelperText>
          A clear, binary YES/NO question. Stored on-chain in the creation
          transaction.
        </FormHelperText>
      </FormControl>

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
            <FormLabel>Committee member pubkeys (slot order, one per line)</FormLabel>
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

      <Button variant="primary" onClick={submit} isLoading={busy}>
        Create Market
      </Button>
    </Box>
  );
}
