import { useEffect, useRef, useState } from "react";
import Big from "big.js";
import { SelectableInput } from "@lib/coinSelect";
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
  InputGroup,
  InputRightAddon,
  Box,
  Heading,
  VStack,
  useToast,
  IconButton,
  Flex,
  Badge,
  Text,
  Divider,
  Spinner,
  Icon,
  HStack,
} from "@chakra-ui/react";
import DataRow from "./DataRow";
import { photonsToRXD } from "@lib/format";
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";
import { ContractType } from "@app/types";
import { p2pkhScript, payToScript } from "@lib/script";
import { feeRate, network, openModal, wallet } from "@app/signals";
import { electrumWorker } from "@app/electrum/Electrum";
import { updateRxdBalances, updateWalletUtxos } from "@app/utxos";
import { UnfinalizedInput } from "@lib/types";
import Balance from "./Balance";
import AddressInput from "./AddressInput";
import { BsQrCodeScan } from "react-icons/bs";
import { transferRadiant } from "@lib/transfer";
import {
  useWaveResolver,
  isPotentialWaveName,
} from "@app/hooks/useWaveResolver";
import { HiOutlineAtSymbol } from "react-icons/hi";

interface Props {
  onSuccess?: (txid: string) => void;
  disclosure: UseDisclosureProps;
}

export default function SendRXD({ onSuccess, disclosure }: Props) {
  const { isOpen, onClose } = disclosure;
  const amount = useRef<HTMLInputElement>(null);
  const toAddress = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const toast = useToast();

  // WAVE name resolution
  const waveResolver = useWaveResolver();
  const [recipientInput, setRecipientInput] = useState("");
  const [finalAddress, setFinalAddress] = useState<string | null>(null);

  // SECURITY FIX (C4): Transaction confirmation modal state
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [pendingTx, setPendingTx] = useState<{
    rawTx: string;
    txid: string;
    recipientAddress: string;
    amount: number;
    fee: number;
    selected: { inputs: SelectableInput[]; outputs: UnfinalizedInput[] };
  } | null>(null);
  // Guards against a double-broadcast if the confirm button is hit twice
  // before the first request resolves.
  const broadcasting = useRef(false);

  const setFailure = (reason: string) => {
    setErrorMessage(reason);
    setSuccess(false);
    setLoading(false);
  };

  // Handle recipient input change for WAVE resolution
  const handleRecipientChange = async (value: string) => {
    setRecipientInput(value);
    waveResolver.clear();
    setFinalAddress(null);

    if (isPotentialWaveName(value)) {
      const resolved = await waveResolver.resolveName(value);
      if (resolved) {
        setFinalAddress(resolved);
      }
    } else if (value) {
      // Check if it's a valid regular address
      const script = payToScript(value);
      if (script) {
        setFinalAddress(value);
      }
    }
  };

  const rxd = useLiveQuery(
    () => db.txo.where({ contractType: ContractType.RXD, spent: 0 }).toArray(),
    [],
    []
  );

  useEffect(() => {
    setSuccess(true);
    setLoading(false);
    waveResolver.clear();
    setRecipientInput("");
    setFinalAddress(null);
    // Never carry a built-but-unbroadcast tx across an open/close.
    setConfirmModalOpen(false);
    setPendingTx(null);
  }, [isOpen]);

  // Build + sign the transaction and show the approval modal. Broadcast and
  // UTXO updates happen only after the user confirms (see confirmBroadcast).
  const buildAndConfirm = async () => {
    setSuccess(true);
    setLoading(true);

    if (!amount.current?.value) {
      return setFailure("Invalid amount");
    }

    // Use resolved WAVE name address or direct address input
    const recipientAddress = finalAddress || toAddress.current?.value || "";
    const p2script = payToScript(recipientAddress);

    if (!p2script) {
      return setFailure("Invalid address or unresolved WAVE name");
    }

    const amountBig = Big(amount.current.value);
    if (amountBig.lte(0)) {
      return setFailure("Invalid amount");
    }

    const value = Number(amountBig.times(100000000).round(0, 0).toString());
    if (!Number.isSafeInteger(value) || value <= 0) {
      return setFailure("Invalid amount");
    }

    // Inline unlock: the wallet may have idle-locked since this modal opened.
    // Prompt for the password in place and resume the send, rather than
    // forcing the user to back out and unlock from the sidebar.
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

    const coins: SelectableInput[] = rxd.slice();
    try {
      const { tx, selected } = transferRadiant(
        coins,
        wallet.value.address,
        p2script,
        value,
        feeRate.value,
        wallet.value.wif!.toString()
      );

      const rawTx = tx.toString();
      const txid = tx.hash;

      // Calculate fee from selected inputs and outputs
      const inputTotal = selected.inputs.reduce(
        (sum, input) => sum + input.value,
        0
      );
      const outputTotal = selected.outputs.reduce(
        (sum, output) => sum + output.value,
        0
      );
      const fee = inputTotal - outputTotal;

      // SECURITY FIX (C4): Show confirmation modal before broadcasting. Carry
      // the selected coins so the UTXO set can be updated after broadcast.
      setPendingTx({
        rawTx,
        txid,
        recipientAddress,
        amount: value,
        fee,
        selected,
      });
      setConfirmModalOpen(true);
      setLoading(false);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Electrum client not connected"
      ) {
        setFailure("Not connected to server. Check your network connection.");
      } else if (error instanceof Error) {
        setFailure(error.message);
      } else {
        setFailure("Could not send transaction");
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

  // SECURITY FIX (C4): Broadcast only after the user confirms in the modal.
  const confirmBroadcast = async () => {
    if (!pendingTx || broadcasting.current) return;
    broadcasting.current = true;

    setLoading(true);
    try {
      console.debug("Broadcasting", pendingTx.rawTx);
      const broadcastTxid = await electrumWorker.value.broadcast(
        pendingTx.rawTx
      );
      // broadcast() returns "" when the server already has the tx in a block;
      // fall back to the locally computed txid so records stay correct.
      const txid = broadcastTxid || pendingTx.txid;
      db.broadcast.put({ txid, date: Date.now(), description: "rxd_send" });
      console.debug("Result", txid);

      // Mark the spent coins and record change now that the tx is on the
      // network. Without this the same coins stayed selectable and a second
      // submit rebuilt and rebroadcast an identical transaction.
      const changeScript = p2pkhScript(wallet.value.address);
      await updateWalletUtxos(
        ContractType.RXD,
        changeScript,
        changeScript,
        txid,
        pendingTx.selected.inputs,
        pendingTx.selected.outputs
      );
      // Recompute the displayed RXD balance from the now-updated UTXO set.
      await updateRxdBalances(wallet.value.address);

      toast({
        title: `Sent ${photonsToRXD(pendingTx.amount)} ${network.value.ticker}`,
        status: "success",
      });

      // Close modal and cleanup
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
          <ModalHeader>{`Send ${network.value.ticker}`}</ModalHeader>
          <ModalCloseButton />
          <AddressInput
            open={scan}
            onScan={onScan}
            onClose={() => setScan(false)}
          >
            <ModalBody pb={6} gap={4} hidden={scan}>
              <VStack>
                <Heading textStyle="h3">{"Balance"}</Heading>
                <Box>
                  <Balance />
                </Box>
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
                {/* WAVE resolution status */}
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
              <FormControl>
                <FormLabel>{"Amount"}</FormLabel>
                <InputGroup>
                  <Input
                    ref={amount}
                    type="number"
                    step="0.00000001"
                    placeholder="0"
                  />
                  <InputRightAddon
                    children={network.value.ticker}
                    userSelect="none"
                  />
                </InputGroup>
              </FormControl>
            </ModalBody>

            <ModalFooter hidden={scan}>
              <Button
                type="submit"
                variant="primary"
                isLoading={loading}
                mr={4}
              >
                {"Send"}
              </Button>
              <Button onClick={onClose}>{"Cancel"}</Button>
            </ModalFooter>
          </AddressInput>
        </ModalContent>
      </form>

      {/* SECURITY FIX (C4): Transaction Confirmation Modal */}
      <Modal
        closeOnOverlayClick={false}
        isOpen={confirmModalOpen}
        onClose={cancelBroadcast}
        isCentered
      >
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>Confirm Transaction</ModalHeader>
          <ModalCloseButton onClick={cancelBroadcast} />
          <ModalBody>
            <VStack align="stretch" spacing={3}>
              <Box>
                <DataRow label="Recipient">
                  <Text wordBreak="break-all">
                    {pendingTx?.recipientAddress}
                  </Text>
                </DataRow>
                <DataRow label="Amount">
                  <Text sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {pendingTx && photonsToRXD(pendingTx.amount)}{" "}
                    {network.value.ticker}
                  </Text>
                </DataRow>
                <DataRow label="Fee">
                  <Text sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {pendingTx && photonsToRXD(pendingTx.fee)}{" "}
                    {network.value.ticker}
                  </Text>
                </DataRow>
                <DataRow label="Total">
                  <Text sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {pendingTx && photonsToRXD(pendingTx.amount + pendingTx.fee)}{" "}
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
                  Please verify the recipient address and amount before
                  confirming.
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
              Confirm & Send
            </Button>
            <Button onClick={cancelBroadcast}>Cancel</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Modal>
  );
}
