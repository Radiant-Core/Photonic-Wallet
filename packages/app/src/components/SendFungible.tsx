import { useEffect, useRef, useState } from "react";
import { t } from "@lingui/macro";
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
  Spinner,
  Icon,
  HStack,
} from "@chakra-ui/react";
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";
import { SmartToken, ContractType } from "@app/types";
import { ftScript, isP2pkh, p2pkhScript } from "@lib/script";
import { feeRate, network, wallet } from "@app/signals";
import { useWaveResolver, isPotentialWaveName } from "@app/hooks/useWaveResolver";
import { HiOutlineAtSymbol } from "react-icons/hi";
import { reverseRef } from "@lib/Outpoint";
import TokenContent from "./TokenContent";
import { RiQuestionFill } from "react-icons/ri";
import { electrumWorker } from "@app/electrum/Electrum";
import FtBalance from "./FtBalance";
import { updateFtBalances, updateWalletUtxos } from "@app/utxos";
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
  }, [isOpen]);

  const ticker = (glyph.ticker as string) || glyph.name || "???";

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSuccess(true);
    setLoading(true);

    if (!amount.current?.value) {
      return setFailure("Invalid amount");
    }

    // Use resolved WAVE name address or direct address input
    const recipientAddress = finalAddress || toAddress.current?.value || "";
    if (!recipientAddress || !isP2pkh(recipientAddress)) {
      return setFailure(waveResolver.isWaveName && !finalAddress ? "WAVE name could not be resolved" : "Invalid address");
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
        wallet.value.wif as string
      );
      const rawTx = tx.toString();
      const changeScript = p2pkhScript(wallet.value.address);

      console.debug("Broadcasting", rawTx);
      const txid = await electrumWorker.value.broadcast(rawTx);
      db.broadcast.put({ txid, date: Date.now(), description: "ft_send" });
      console.debug("Result", txid);
      toast({
        title: `Sent ${value} ${ticker}`,
        status: "success",
      });

      await updateWalletUtxos(
        ContractType.FT,
        fromScript, // FT change
        changeScript, // RXD change
        txid,
        selected.inputs,
        selected.outputs
      );
      updateFtBalances(new Set([fromScript]));

      onSuccess && onSuccess(txid);
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

  const [scan, setScan] = useState(false);
  const onScan = (value: string) => {
    setScan(false);
    setSuccess(true);
    handleRecipientChange(value);
    if (toAddress.current) {
      toAddress.current.value = value;
    }
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
    </Modal>
  );
}
