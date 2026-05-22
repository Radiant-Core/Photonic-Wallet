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
import { feeRate, network, wallet } from "@app/signals";
import { electrumWorker } from "@app/electrum/Electrum";
import { updateWalletUtxos, updateNFTOwned } from "@app/utxos";
import { BsQrCodeScan } from "react-icons/bs";
import AddressInput from "./AddressInput";
import { TransferError, transferNonFungible } from "@lib/transfer";

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
  } | null>(null);

  const rxd = useLiveQuery(
    () => db.txo.where({ contractType: ContractType.RXD, spent: 0 }).toArray(),
    [],
    []
  );

  useEffect(() => {
    setSuccess(true);
    setLoading(false);
  }, [isOpen]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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

  const [scan, setScan] = useState(false);
  const onScan = (value: string) => {
    setScan(false);
    setSuccess(true);
    if (toAddress.current) {
      toAddress.current.value = value;
    }
  };

  // SECURITY FIX (C4): Function to broadcast after user confirms in modal
  const confirmBroadcast = async () => {
    if (!pendingTx) return;

    setLoading(true);
    try {
      console.debug("Broadcasting", pendingTx.rawTx);
      const txid = await electrumWorker.value.broadcast(pendingTx.rawTx);
      db.broadcast.put({ txid, date: Date.now(), description: "nft_send" });
      console.debug("Result", txid);

      toast({
        title: `Sent NFT: ${pendingTx.nftName}`,
        status: "success",
      });

      // Close modals and cleanup
      setConfirmModalOpen(false);
      setPendingTx(null);

      // Update UTXOs and refresh UI
      const changeScript = p2pkhScript(wallet.value.address);
      const sendToSelf = pendingTx.recipientAddress === wallet.value.address;

      // Update NFT UTXOs if sent to self
      if (sendToSelf) {
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
      }
      updateNFTOwned(wallet.value.address);

      if (onSuccess) onSuccess(txid);
    } catch (error) {
      console.error("Broadcast error:", error);
      toast({
        title: "Transaction failed",
        description: error instanceof Error ? error.message : "Unknown error",
        status: "error",
      });
    } finally {
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
            <VStack align="start" spacing={3}>
              <Text>
                <strong>Recipient:</strong> {pendingTx?.recipientAddress}
              </Text>
              <Text>
                <strong>NFT:</strong> {pendingTx?.nftName}
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
                Please verify the recipient address before confirming. This
                action cannot be undone.
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
