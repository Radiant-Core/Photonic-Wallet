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
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";
import { ContractType, TxO } from "@app/types";
import { ftScript, isP2pkh } from "@lib/script";
import { feeRate, network, openModal, wallet } from "@app/signals";
import {
  useWaveResolver,
  isPotentialWaveName,
} from "@app/hooks/useWaveResolver";
import { HiOutlineAtSymbol } from "react-icons/hi";
import Outpoint, { reverseRef } from "@lib/Outpoint";
import { electrumWorker } from "@app/electrum/Electrum";
import { updateAfterBatchTransfer } from "@app/utxos";
import AddressInput from "./AddressInput";
import { BsQrCodeScan } from "react-icons/bs";
import {
  BatchFtInput,
  BatchNftInput,
  transferBatch,
  TransferError,
} from "@lib/transfer";
import DataRow from "./DataRow";

// A single asset the user picked for a batch send. `ref` is the BE display ref
// (matches SmartToken.ref); the full balance of each FT type is sent.
export type BatchSendItem = {
  kind: "ft" | "nft";
  ref: string;
  name: string;
  ticker?: string;
};

interface Props {
  items: BatchSendItem[];
  onSuccess?: (txid: string) => void;
  disclosure: UseDisclosureProps;
}

type PendingBatch = {
  rawTx: string;
  txid: string;
  recipientAddress: string;
  fee: number;
  ftCount: number;
  nftCount: number;
  selected: { inputs: SelectableInput[]; outputs: UnfinalizedInput[] };
  ftScripts: Set<string>;
  sentNftTxoIds: number[];
};

export default function SendBatch({ items, onSuccess, disclosure }: Props) {
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
  const [pendingTx, setPendingTx] = useState<PendingBatch | null>(null);
  const broadcasting = useRef(false);

  const rxd = useLiveQuery(
    () => db.txo.where({ contractType: ContractType.RXD, spent: 0 }).toArray(),
    [],
    []
  );

  const ftItems = items.filter((i) => i.kind === "ft");
  const nftItems = items.filter((i) => i.kind === "nft");

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
      if (resolved) {
        setFinalAddress(resolved);
      }
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

  // Gather the UTXOs for the selected assets, build + sign the transaction, and
  // open the approval modal. Nothing is broadcast here.
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

    if (!items.length) {
      return setFailure("No assets selected");
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
      // Collect FT groups (full balance of each selected token type).
      const ftGroups: BatchFtInput[] = [];
      const ftScripts = new Set<string>();
      for (const item of ftItems) {
        const refLE = reverseRef(item.ref);
        const script = ftScript(wallet.value.address, refLE);
        const utxos = (await db.txo
          .where({ script, spent: 0 })
          .toArray()) as SelectableInput[];
        if (!utxos.length) continue;
        ftGroups.push({ refLE, utxos });
        ftScripts.add(script);
      }

      // Collect NFT singletons (resolve the current UTXO from each glyph).
      const nftInputs: BatchNftInput[] = [];
      const sentNftTxoIds: number[] = [];
      for (const item of nftItems) {
        const glyph = await db.glyph.get({ ref: item.ref });
        if (!glyph?.lastTxoId) continue;
        const txo = (await db.txo.get({ id: glyph.lastTxoId })) as TxO;
        if (!txo || txo.spent) continue;
        const refLE = Outpoint.fromString(
          txo.script.substring(2, 74)
        ).toString();
        nftInputs.push({ refLE, utxo: txo as SelectableInput });
        if (txo.id) sentNftTxoIds.push(txo.id);
      }

      if (!ftGroups.length && !nftInputs.length) {
        return setFailure("Selected assets are no longer available");
      }

      const coins: SelectableInput[] = rxd.slice();
      const { tx, selected } = transferBatch(
        coins,
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
        selected: selected as PendingBatch["selected"],
        ftScripts,
        sentNftTxoIds,
      });
      setConfirmModalOpen(true);
      setLoading(false);
    } catch (error) {
      if (error instanceof TransferError) {
        setFailure(error.message);
      } else {
        setFailure("Could not build transaction");
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
    if (toAddress.current) {
      toAddress.current.value = value;
    }
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
      db.broadcast.put({ txid, date: Date.now(), description: "batch_send" });

      await updateAfterBatchTransfer({
        ownAddress: wallet.value.address,
        txid,
        inputs: pendingTx.selected.inputs,
        outputs: pendingTx.selected.outputs,
        ftScripts: pendingTx.ftScripts,
        sentNftTxoIds: pendingTx.sentNftTxoIds,
        nftLeftWallet: pendingTx.recipientAddress !== wallet.value.address,
      });

      const parts = [];
      if (pendingTx.ftCount)
        parts.push(`${pendingTx.ftCount} token${pendingTx.ftCount > 1 ? "s" : ""}`);
      if (pendingTx.nftCount)
        parts.push(`${pendingTx.nftCount} NFT${pendingTx.nftCount > 1 ? "s" : ""}`);
      toast({ title: `Sent ${parts.join(" and ")}`, status: "success" });

      setConfirmModalOpen(false);
      setPendingTx(null);
      if (onSuccess) onSuccess(txid);
    } catch (error) {
      console.error("Broadcast error:", error);
      toast({
        title: "Transaction failed",
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
          <ModalHeader>{`Send ${items.length} item${
            items.length === 1 ? "" : "s"
          }`}</ModalHeader>
          <ModalCloseButton />
          <AddressInput
            open={scan}
            onScan={onScan}
            onClose={() => setScan(false)}
          >
            <ModalBody pb={6} gap={4} hidden={scan}>
              <VStack align="stretch" spacing={3} mb={4}>
                <HStack justify="center" spacing={3}>
                  {ftItems.length > 0 && (
                    <Badge colorScheme="brand">
                      {ftItems.length} fungible
                    </Badge>
                  )}
                  {nftItems.length > 0 && (
                    <Badge colorScheme="purple">{nftItems.length} NFT</Badge>
                  )}
                </HStack>
                <Box
                  maxH="120px"
                  overflowY="auto"
                  fontSize="sm"
                  color="text.muted"
                  borderWidth={1}
                  borderColor="whiteAlpha.200"
                  borderRadius="md"
                  p={2}
                >
                  {items.map((item) => (
                    <Flex key={`${item.kind}:${item.ref}`} justify="space-between">
                      <Text noOfLines={1}>{item.name || "Unnamed"}</Text>
                      <Text textTransform="uppercase" ml={2}>
                        {item.kind === "ft"
                          ? (item.ticker || "FT")
                          : "NFT"}
                      </Text>
                    </Flex>
                  ))}
                </Box>
                {ftItems.length > 0 && (
                  <Alert status="info" borderRadius="md" fontSize="xs">
                    <AlertIcon />
                    <AlertDescription>
                      The full balance of each selected fungible token will be
                      sent.
                    </AlertDescription>
                  </Alert>
                )}
              </VStack>
              {success || (
                <Alert status="error" mb={4}>
                  <AlertIcon />
                  <AlertDescription>{errorMessage}</AlertDescription>
                </Alert>
              )}
              <FormControl>
                <FormLabel>
                  <HStack spacing={2}>
                    <span>To</span>
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
                    placeholder={`${network.value.name} address or WAVE name (e.g., alice.rxd)`}
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
                {"Send all"}
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
          <ModalHeader>Confirm Batch Send</ModalHeader>
          <ModalCloseButton onClick={cancelBroadcast} />
          <ModalBody>
            <VStack align="stretch" spacing={3}>
              <Box>
                <DataRow label="Recipient">
                  <Text wordBreak="break-all">
                    {pendingTx?.recipientAddress}
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
                  Please verify the recipient address before confirming. This
                  action cannot be undone.
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
              Confirm &amp; Send
            </Button>
            <Button onClick={cancelBroadcast}>Cancel</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Modal>
  );
}
