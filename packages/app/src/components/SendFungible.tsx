import { useEffect, useRef, useState } from "react";
import { SelectableInput } from "@lib/coinSelect";
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
  Spinner,
  Divider,
  Icon,
  HStack,
} from "@chakra-ui/react";
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";
import { SmartToken, ContractType } from "@app/types";
import { ftScript, isP2pkh, p2pkhScript } from "@lib/script";
import { feeRate, network, openModal, wallet } from "@app/signals";
import { UnfinalizedInput } from "@lib/types";
import {
  useWaveResolver,
  isPotentialWaveName,
} from "@app/hooks/useWaveResolver";
import { HiOutlineAtSymbol } from "react-icons/hi";
import { reverseRef } from "@lib/Outpoint";
import TokenContent from "./TokenContent";
import { RiQuestionFill } from "react-icons/ri";
import { electrumWorker } from "@app/electrum/Electrum";
import FtBalance from "./FtBalance";
import {
  updateFtBalances,
  updateRxdBalances,
  updateWalletUtxos,
} from "@app/utxos";
import AddressInput from "./AddressInput";
import { BsQrCodeScan } from "react-icons/bs";
import { TransferError, transferFungible } from "@lib/transfer";

interface Props {
  glyph: SmartToken;
  onSuccess?: (txid: string) => void;
  disclosure: UseDisclosureProps;
}

export default function SendFungible({ glyph, onSuccess, disclosure }: Props) {
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
    tokenAmount: string;
    fromScript: string;
    selected: { inputs: SelectableInput[]; outputs: UnfinalizedInput[] };
  } | null>(null);
  // Guards against a double-broadcast if the confirm button is hit twice
  // before the first request resolves.
  const broadcasting = useRef(false);

  const rxd = useLiveQuery(
    () => db.txo.where({ contractType: ContractType.RXD, spent: 0 }).toArray(),
    [],
    []
  );

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
      if (isP2pkh(value)) {
        setFinalAddress(value);
      }
    }
  };

  useEffect(() => {
    setSuccess(true);
    setLoading(false);
    waveResolver.clear();
    setRecipientInput("");
    setFinalAddress(null);
    // Never carry a built-but-unbroadcast tx across an open/close. Without
    // this, reopening the modal re-showed a stale approval for the previous
    // transaction.
    setConfirmModalOpen(false);
    setPendingTx(null);
  }, [isOpen]);

  const ticker = (glyph.ticker as string) || glyph.name || "???";

  // Build + sign the transaction and show the approval modal. Nothing is
  // broadcast and no wallet state is mutated here — that happens only after
  // the user confirms (see confirmBroadcast). Previously this fired onSuccess
  // and updated the UTXO set before broadcasting, which produced a phantom
  // success (txid shown for a tx never sent) and corrupted balances on cancel.
  const buildAndConfirm = async () => {
    setSuccess(true);
    setLoading(true);

    if (!amount.current?.value) {
      return setFailure("Invalid amount");
    }

    // Use resolved WAVE name address or direct address input
    const recipientAddress = finalAddress || toAddress.current?.value || "";
    if (!recipientAddress || !isP2pkh(recipientAddress)) {
      return setFailure(
        waveResolver.isWaveName && !finalAddress
          ? "WAVE name could not be resolved"
          : "Invalid address"
      );
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

    const value = parseInt(amount.current?.value, 10);
    const refLE = reverseRef(glyph.ref);
    const fromScript = ftScript(wallet.value.address, refLE);
    const tokens = await db.txo
      .where({ script: fromScript, spent: 0 })
      .toArray();

    const coins: SelectableInput[] = rxd.slice();
    try {
      const { tx, selected } = transferFungible(
        coins,
        tokens,
        refLE,
        wallet.value.address,
        recipientAddress,
        value,
        feeRate.value,
        wallet.value.wif!.toString()
      );
      const rawTx = tx.toString();
      const txid = tx.hash;

      // Calculate fee
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
      // the selected coins so the UTXO set can be updated *after* a successful
      // broadcast (in confirmBroadcast), not before.
      setPendingTx({
        rawTx,
        txid,
        recipientAddress,
        amount: value,
        fee,
        tokenAmount: `${value} ${ticker}`,
        fromScript,
        selected,
      });
      setConfirmModalOpen(true);
      setLoading(false);
    } catch (error) {
      if (error instanceof TransferError) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage("Could not send transaction");
      }
      console.error(error);
      setSuccess(false);
      setLoading(false);
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
      db.broadcast.put({ txid, date: Date.now(), description: "ft_send" });
      console.debug("Result", txid);

      // Update the local UTXO set only now that the tx is on the network.
      await updateWalletUtxos(
        ContractType.FT,
        pendingTx.fromScript, // FT change
        p2pkhScript(wallet.value.address), // RXD change
        txid,
        pendingTx.selected.inputs,
        pendingTx.selected.outputs
      );
      updateFtBalances(new Set([pendingTx.fromScript]));
      // The send also consumed RXD coins for the fee (and produced RXD change),
      // so refresh the RXD balance too — otherwise it shows stale until sync.
      await updateRxdBalances(wallet.value.address);

      toast({
        title: `Sent ${pendingTx.tokenAmount}`,
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
          <ModalHeader>{`Send ${glyph.name || ticker}`}</ModalHeader>
          <ModalCloseButton />
          <AddressInput
            open={scan}
            onScan={onScan}
            onClose={() => setScan(false)}
          >
            <ModalBody pb={6} gap={4} hidden={scan}>
              <VStack>
                <Box w="48px" h="48px">
                  <TokenContent
                    glyph={glyph}
                    defaultIcon={RiQuestionFill}
                    thumbnail
                  />
                </Box>
                <Heading size="sm">{"Balance"}</Heading>
                <Box>
                  <FtBalance id={glyph.ref} />
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
                    <Text fontSize="xs" color="gray.500">
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
                  <Input ref={amount} type="number" placeholder="0" />
                  <InputRightAddon children={ticker} userSelect="none" />
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
            <VStack align="start" spacing={3}>
              <Text>
                <strong>Recipient:</strong> {pendingTx?.recipientAddress}
              </Text>
              <Text>
                <strong>Token Amount:</strong> {pendingTx?.tokenAmount}
              </Text>
              <Text>
                <strong>Fee:</strong> {pendingTx && photonsToRXD(pendingTx.fee)}{" "}
                {network.value.ticker}
              </Text>
              <Text>
                <strong>Total Cost:</strong>{" "}
                {pendingTx && photonsToRXD(pendingTx.fee)}{" "}
                {network.value.ticker}
              </Text>
              <Text fontSize="xs" color="gray.500">
                <strong>TxID:</strong> {pendingTx?.txid}
              </Text>
              <Divider my={2} />
              <Text fontSize="sm" color="orange.500">
                Please verify the recipient address and amount before
                confirming.
              </Text>
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
