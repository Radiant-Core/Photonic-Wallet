import { useEffect, useRef, useState } from "react";
import { SelectableInput } from "@lib/coinSelect";
import { UnfinalizedInput } from "@lib/types";
import { photonsToRXD } from "@lib/format";
import {
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  FormControl,
  FormLabel,
  Input,
  ModalCloseButton,
  UseDisclosureProps,
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  VStack,
  useToast,
  IconButton,
  Flex,
  Badge,
  Text,
  Spinner,
  Divider,
  Icon,
  HStack,
} from "@chakra-ui/react";
import db from "@app/db";
import { ContractType, SmartTokenType, TxO } from "@app/types";
import { isP2pkh, parseFtScript } from "@lib/script";
import { feeRate, network, openModal, wallet } from "@app/signals";
import {
  useWaveResolver,
  isPotentialWaveName,
} from "@app/hooks/useWaveResolver";
import { HiOutlineAtSymbol } from "react-icons/hi";
import Outpoint from "@lib/Outpoint";
import { electrumWorker } from "@app/electrum/Electrum";
import { updateAfterBatchTransfer } from "@app/utxos";
import AddressInput from "./AddressInput";
import { BsQrCodeScan } from "react-icons/bs";
import {
  BatchFtInput,
  BatchNftInput,
  sweepAll,
  TransferError,
} from "@lib/transfer";
import DataRow from "./DataRow";

interface Props {
  disclosure: UseDisclosureProps;
  onSuccess?: (txid: string) => void;
}

type PendingSweep = {
  rawTx: string;
  txid: string;
  recipientAddress: string;
  fee: number;
  ftCount: number;
  nftCount: number;
  rxdSwept: number;
  selected: { inputs: SelectableInput[]; outputs: UnfinalizedInput[] };
  ftScripts: Set<string>;
  sentNftTxoIds: number[];
};

// Gather every ordinary RXD / FT / NFT UTXO the wallet can spend.
async function collectWalletAssets() {
  const rxd = (await db.txo
    .where({ contractType: ContractType.RXD, spent: 0 })
    .toArray()) as SelectableInput[];

  // Group FT UTXOs by their locking script (one consolidated output per type).
  const allFts = await db.txo
    .where({ contractType: ContractType.FT, spent: 0 })
    .toArray();
  const byScript = new Map<string, TxO[]>();
  for (const ft of allFts) {
    const list = byScript.get(ft.script) || [];
    list.push(ft);
    byScript.set(ft.script, list);
  }
  const ftGroups: BatchFtInput[] = [];
  const ftScripts = new Set<string>();
  for (const [script, utxos] of byScript) {
    const { ref } = parseFtScript(script); // little-endian ref
    if (!ref) continue;
    ftGroups.push({ refLE: ref, utxos: utxos as SelectableInput[] });
    ftScripts.add(script);
  }

  // Resolve each owned NFT's current singleton UTXO.
  const nftGlyphs = await db.glyph
    .where("tokenType")
    .equals(SmartTokenType.NFT)
    .filter((g) => g.spent === 0 && !!g.lastTxoId)
    .toArray();
  const nftInputs: BatchNftInput[] = [];
  const sentNftTxoIds: number[] = [];
  for (const glyph of nftGlyphs) {
    const txo = (await db.txo.get({ id: glyph.lastTxoId })) as TxO;
    if (!txo || txo.spent) continue;
    const refLE = Outpoint.fromString(txo.script.substring(2, 74)).toString();
    nftInputs.push({ refLE, utxo: txo as SelectableInput });
    if (txo.id) sentNftTxoIds.push(txo.id);
  }

  const rxdTotal = rxd.reduce((s, c) => s + c.value, 0);

  return { rxd, ftGroups, ftScripts, nftInputs, sentNftTxoIds, rxdTotal };
}

export default function SweepModal({ disclosure, onSuccess }: Props) {
  const { isOpen, onClose } = disclosure;
  const toAddress = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const toast = useToast();

  const waveResolver = useWaveResolver();
  const [recipientInput, setRecipientInput] = useState("");
  const [finalAddress, setFinalAddress] = useState<string | null>(null);

  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [pendingTx, setPendingTx] = useState<PendingSweep | null>(null);
  const broadcasting = useRef(false);

  const setFailure = (reason: string) => {
    setErrorMessage(reason);
    setSuccess(false);
    setLoading(false);
  };

  const handleRecipientChange = async (value: string) => {
    setRecipientInput(value);
    waveResolver.clear();
    setFinalAddress(null);

    if (isPotentialWaveName(value)) {
      const resolved = await waveResolver.resolveName(value);
      if (resolved) setFinalAddress(resolved);
    } else if (value && isP2pkh(value)) {
      setFinalAddress(value);
    }
  };

  useEffect(() => {
    setSuccess(true);
    setLoading(false);
    waveResolver.clear();
    setRecipientInput("");
    setFinalAddress(null);
    setConfirmModalOpen(false);
    setPendingTx(null);
  }, [isOpen]);

  const buildAndConfirm = async () => {
    setSuccess(true);
    setLoading(true);

    const recipientAddress = finalAddress || toAddress.current?.value || "";
    if (!recipientAddress || !isP2pkh(recipientAddress)) {
      return setFailure(
        waveResolver.isWaveName && !finalAddress
          ? "WAVE name could not be resolved"
          : "Invalid address"
      );
    }

    if (wallet.value.locked || !wallet.value.wif) {
      setLoading(false);
      openModal.value = {
        modal: "unlock",
        onClose: (unlocked) => {
          if (unlocked) buildAndConfirm();
        },
      };
      return;
    }

    try {
      const {
        rxd,
        ftGroups,
        ftScripts,
        nftInputs,
        sentNftTxoIds,
        rxdTotal,
      } = await collectWalletAssets();

      if (!rxd.length && !ftGroups.length && !nftInputs.length) {
        return setFailure("Nothing to sweep — the wallet is empty");
      }

      const { tx, selected } = sweepAll(
        rxd,
        ftGroups,
        nftInputs,
        wallet.value.address,
        recipientAddress,
        feeRate.value,
        wallet.value.wif!.toString()
      );

      const inputTotal = selected.inputs.reduce((s, i) => s + i.value, 0);
      const outputTotal = selected.outputs.reduce((s, o) => s + o.value, 0);
      const fee = inputTotal - outputTotal;

      setPendingTx({
        rawTx: tx.toString(),
        txid: tx.hash,
        recipientAddress,
        fee,
        ftCount: ftGroups.length,
        nftCount: nftInputs.length,
        rxdSwept: Math.max(0, rxdTotal - fee),
        selected: selected as PendingSweep["selected"],
        ftScripts,
        sentNftTxoIds,
      });
      setConfirmModalOpen(true);
      setLoading(false);
    } catch (error) {
      if (error instanceof TransferError) {
        setFailure(error.message);
      } else {
        setFailure("Could not build sweep transaction");
      }
      console.error(error);
    }
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    buildAndConfirm();
  };

  const [scan, setScan] = useState(false);
  const onScan = (value: string) => {
    setScan(false);
    setSuccess(true);
    handleRecipientChange(value);
    if (toAddress.current) toAddress.current.value = value;
  };

  const confirmBroadcast = async () => {
    if (!pendingTx || broadcasting.current) return;
    broadcasting.current = true;

    setLoading(true);
    try {
      const broadcastTxid = await electrumWorker.value.broadcast(
        pendingTx.rawTx
      );
      const txid = broadcastTxid || pendingTx.txid;
      db.broadcast.put({ txid, date: Date.now(), description: "sweep" });

      await updateAfterBatchTransfer({
        ownAddress: wallet.value.address,
        txid,
        inputs: pendingTx.selected.inputs,
        outputs: pendingTx.selected.outputs,
        ftScripts: pendingTx.ftScripts,
        sentNftTxoIds: pendingTx.sentNftTxoIds,
        // A sweep moves everything out (unless the user swept to their own
        // address — then the NFTs technically stay, but a self-sweep is a no-op
        // a user would not normally do; the background sync re-points them).
        nftLeftWallet: pendingTx.recipientAddress !== wallet.value.address,
      });

      toast({ title: "Wallet swept", status: "success" });
      setConfirmModalOpen(false);
      setPendingTx(null);
      if (onSuccess) onSuccess(txid);
      onClose?.();
    } catch (error) {
      console.error("Broadcast error:", error);
      toast({
        title: "Sweep failed",
        description: error instanceof Error ? error.message : "Unknown error",
        status: "error",
      });
    } finally {
      broadcasting.current = false;
      setLoading(false);
    }
  };

  const cancelBroadcast = () => {
    setConfirmModalOpen(false);
    setPendingTx(null);
  };

  if (!isOpen || !onClose) return null;

  return (
    <Modal
      closeOnOverlayClick
      isOpen={isOpen}
      onClose={onClose}
      initialFocusRef={toAddress}
      isCentered
    >
      <form onSubmit={submit}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>Sweep wallet</ModalHeader>
          <ModalCloseButton />
          <AddressInput
            open={scan}
            onScan={onScan}
            onClose={() => setScan(false)}
          >
            <ModalBody pb={6} gap={4} hidden={scan}>
              <Alert status="warning" borderRadius="md" mb={4} fontSize="sm">
                <AlertIcon />
                <AlertDescription>
                  This moves all RXD, fungible tokens and NFTs out of this
                  wallet to the address below. The network fee is calculated
                  automatically and deducted from the swept RXD.
                </AlertDescription>
              </Alert>
              {success || (
                <Alert status="error" mb={4}>
                  <AlertIcon />
                  <AlertDescription>{errorMessage}</AlertDescription>
                </Alert>
              )}
              <FormControl>
                <FormLabel>
                  <HStack spacing={2}>
                    <span>Destination</span>
                    {waveResolver.isWaveName && (
                      <Badge colorScheme="brand" size="sm">
                        <Icon as={HiOutlineAtSymbol} boxSize={3} mr={1} />
                        WAVE
                      </Badge>
                    )}
                  </HStack>
                </FormLabel>
                <Flex gap={2}>
                  <Input
                    ref={toAddress}
                    type="text"
                    placeholder={`${network.value.name} address or WAVE name`}
                    value={recipientInput}
                    onChange={(e) => handleRecipientChange(e.target.value)}
                  />
                  <IconButton
                    icon={<BsQrCodeScan />}
                    aria-label="Scan QR code"
                    onClick={() => setScan(true)}
                  />
                </Flex>
                {waveResolver.isResolving && (
                  <Flex align="center" mt={2} gap={2}>
                    <Spinner size="xs" />
                    <Text fontSize="xs" color="text.muted">
                      {"Resolving WAVE name..."}
                    </Text>
                  </Flex>
                )}
                {waveResolver.error && (
                  <Alert status="warning" mt={2} size="sm" borderRadius="md">
                    <AlertIcon boxSize={4} />
                    <AlertDescription fontSize="xs">
                      {waveResolver.error}
                    </AlertDescription>
                  </Alert>
                )}
                {waveResolver.resolvedAddress && (
                  <Alert status="success" mt={2} size="sm" borderRadius="md">
                    <AlertIcon boxSize={4} />
                    <AlertDescription fontSize="xs" wordBreak="break-all">
                      {"Resolved to:"} {waveResolver.resolvedAddress}
                    </AlertDescription>
                  </Alert>
                )}
              </FormControl>
            </ModalBody>

            <ModalFooter hidden={scan}>
              <Button
                type="submit"
                variant="primary"
                isLoading={loading}
                mr={4}
              >
                {"Review sweep"}
              </Button>
              <Button onClick={onClose}>{"Cancel"}</Button>
            </ModalFooter>
          </AddressInput>
        </ModalContent>
      </form>

      <Modal
        closeOnOverlayClick={false}
        isOpen={confirmModalOpen}
        onClose={cancelBroadcast}
        isCentered
      >
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>Confirm Sweep</ModalHeader>
          <ModalCloseButton onClick={cancelBroadcast} />
          <ModalBody>
            <VStack align="stretch" spacing={3}>
              <Box>
                <DataRow label="Destination">
                  <Text wordBreak="break-all">
                    {pendingTx?.recipientAddress}
                  </Text>
                </DataRow>
                <DataRow label="RXD swept">
                  <Text sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {pendingTx && photonsToRXD(pendingTx.rxdSwept)}{" "}
                    {network.value.ticker}
                  </Text>
                </DataRow>
                <DataRow label="Fungible tokens">
                  <Text sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {pendingTx?.ftCount ?? 0}
                  </Text>
                </DataRow>
                <DataRow label="NFTs">
                  <Text sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {pendingTx?.nftCount ?? 0}
                  </Text>
                </DataRow>
                <DataRow label="Fee">
                  <Text sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {pendingTx && photonsToRXD(pendingTx.fee)}{" "}
                    {network.value.ticker}
                  </Text>
                </DataRow>
                <DataRow label="TxID">
                  <Text fontSize="xs" color="text.muted" wordBreak="break-all">
                    {pendingTx?.txid}
                  </Text>
                </DataRow>
              </Box>
              <Divider my={2} />
              <Alert status="warning" borderRadius="md">
                <AlertIcon />
                <AlertDescription>
                  This empties your wallet. Verify the destination address —
                  this action cannot be undone.
                </AlertDescription>
              </Alert>
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button
              variant="primary"
              isLoading={loading}
              onClick={confirmBroadcast}
              mr={4}
            >
              Confirm &amp; Sweep
            </Button>
            <Button onClick={cancelBroadcast}>Cancel</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Modal>
  );
}
