import { useEffect, useRef, useState } from "react";
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
  useToast,
  Flex,
  IconButton,
  Text,
  VStack,
  Divider,
} from "@chakra-ui/react";
import { photonsToRXD } from "@lib/format";
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";
import { ContractType, SmartToken, TxO } from "@app/types";
import { isP2pkh, p2pkhScript } from "@lib/script";
import Identifier from "./Identifier";
import Outpoint from "@lib/Outpoint";
import { feeRate, network, openModal, wallet } from "@app/signals";
import { electrumWorker } from "@app/electrum/Electrum";
import {
  updateNFTOwned,
  updateRxdBalances,
  updateWalletUtxos,
} from "@app/utxos";
import { UnfinalizedInput } from "@lib/types";
import { BsQrCodeScan } from "react-icons/bs";
import AddressInput from "./AddressInput";
import { TransferError, transferNonFungible } from "@lib/transfer";
import DataRow from "./DataRow";

interface Props {
  glyph: SmartToken;
  txo: TxO;
  onSuccess?: (txid: string) => void;
  disclosure: UseDisclosureProps;
}

export default function SendDigitalObject({
  glyph,
  txo,
  onSuccess,
  disclosure,
}: Props) {
  const { isOpen, onClose } = disclosure;
  const toAddress = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const toast = useToast();
  const ref = Outpoint.fromString(txo.script.substring(2, 74));

  // SECURITY FIX (C4): Transaction confirmation modal state
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [pendingTx, setPendingTx] = useState<{
    rawTx: string;
    txid: string;
    recipientAddress: string;
    fee: number;
    nftName: string;
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

  useEffect(() => {
    setSuccess(true);
    setLoading(false);
    // Never carry a built-but-unbroadcast tx across an open/close.
    setConfirmModalOpen(false);
    setPendingTx(null);
  }, [isOpen]);

  // Build + sign the transaction and show the approval modal. Broadcast and
  // UTXO updates happen only after the user confirms (see confirmBroadcast).
  const buildAndConfirm = async () => {
    setSuccess(true);
    setLoading(true);

    let fail = false;
    if (!toAddress.current?.value || !isP2pkh(toAddress.current.value)) {
      fail = true;
      setErrorMessage("Invalid address");
    }

    if (fail) {
      setSuccess(false);
      setLoading(false);
      return;
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
      const { tx, selected } = transferNonFungible(
        coins,
        txo,
        ref.toString(),
        wallet.value.address,
        toAddress.current?.value as string,
        feeRate.value,
        wallet.value.wif!.toString()
      );

      const rawTx = tx.toString();
      const txid = tx.hash;

      // Calculate fee from inputs and outputs
      const inputTotal = selected.inputs.reduce(
        (sum, input) => sum + input.value,
        0
      );
      const outputTotal = selected.outputs.reduce(
        (sum, output) => sum + output.value,
        0
      );
      const fee = inputTotal - outputTotal;

      // SECURITY FIX (C4): Show confirmation modal before broadcasting
      setPendingTx({
        rawTx,
        txid,
        recipientAddress: toAddress.current?.value || "",
        fee,
        nftName: glyph?.name || "Unknown NFT",
        selected,
      });
      setConfirmModalOpen(true);
      setLoading(false);
    } catch (error) {
      if (error instanceof TransferError) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage("Transaction rejected");
      }
      console.debug(error);
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
      db.broadcast.put({ txid, date: Date.now(), description: "nft_send" });
      console.debug("Result", txid);

      // Update UTXOs and refresh UI
      const changeScript = p2pkhScript(wallet.value.address);
      const sendToSelf = pendingTx.recipientAddress === wallet.value.address;

      if (sendToSelf) {
        // Sending to your own address — the NFT stays owned. Keep the existing
        // approximate handling and let the background sync re-point the glyph.
        await updateWalletUtxos(
          ContractType.NFT,
          p2pkhScript(wallet.value.address), // Will find by outpoint
          changeScript,
          txid,
          [],
          [
            {
              script: p2pkhScript(wallet.value.address),
              value: 0,
              txid,
              vout: 0,
            },
          ]
        );
      } else {
        // The NFT leaves the wallet. The grid filters on the glyph row's
        // `spent` flag (see pages/Wallet.tsx), not the txo, so mark the glyph
        // spent — otherwise it lingers until the next background sync. Mirrors
        // electrum/worker/NFT.ts.
        if (txo.id) {
          await db.glyph.where({ lastTxoId: txo.id }).modify({ spent: 1 });
        }
        // Mark the NFT input and the RXD fee coins spent, and record RXD
        // change, so none of them are reselected by a later send.
        await updateWalletUtxos(
          ContractType.RXD,
          changeScript,
          changeScript,
          txid,
          pendingTx.selected.inputs,
          pendingTx.selected.outputs
        );
      }

      // The send consumed RXD for the fee, so refresh the RXD balance.
      await updateRxdBalances(wallet.value.address);
      updateNFTOwned(wallet.value.address);

      toast({
        title: `Sent NFT: ${pendingTx.nftName}`,
        status: "success",
      });

      // Close modals and cleanup
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
      isOpen={isOpen}
      onClose={onClose}
      initialFocusRef={toAddress}
      isCentered
    >
      <form onSubmit={submit}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{"Send Non-Fungible Token"}</ModalHeader>
          <ModalCloseButton />
          <AddressInput
            open={scan}
            onScan={onScan}
            onClose={() => setScan(false)}
          >
            <ModalBody pb={6} gap={4} hidden={scan}>
              {success || (
                <Alert status="error" mb={4}>
                  <AlertIcon />
                  <AlertDescription>{errorMessage}</AlertDescription>
                </Alert>
              )}
              <FormControl>
                <FormLabel>To</FormLabel>
                <Flex gap={2}>
                  <Input
                    ref={toAddress}
                    type="text"
                    placeholder={`${network.value.name} address`}
                  />
                  <IconButton
                    icon={<BsQrCodeScan />}
                    aria-label="Scan QR code"
                    onClick={() => setScan(true)}
                  />
                </Flex>
              </FormControl>
              <FormControl>
                <FormLabel>{"Non-Fungible Token"}</FormLabel>
                <Identifier>{ref.reverse().shortInput()}</Identifier>
              </FormControl>
              <FormControl>
                <FormLabel>{"Amount"}</FormLabel>
                <Identifier>{`${photonsToRXD(txo.value)} ${
                  network.value.ticker
                }`}</Identifier>
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
              <VStack align="stretch" spacing={0}>
                <DataRow label="Recipient">
                  <Text wordBreak="break-all">
                    {pendingTx?.recipientAddress}
                  </Text>
                </DataRow>
                <DataRow label="NFT">
                  <Text>{pendingTx?.nftName}</Text>
                </DataRow>
                <DataRow label="Fee">
                  <Text sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {pendingTx && photonsToRXD(pendingTx.fee)}{" "}
                    {network.value.ticker}
                  </Text>
                </DataRow>
                <DataRow label="Total Cost">
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
              </VStack>
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
              Confirm & Send
            </Button>
            <Button onClick={cancelBroadcast}>Cancel</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Modal>
  );
}
