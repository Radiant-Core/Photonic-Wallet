import { useEffect, useState } from "react";
import {
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
  Button,
  FormControl,
  FormLabel,
  FormHelperText,
  Input,
  Alert,
  AlertIcon,
  AlertDescription,
  UseDisclosureProps,
  useToast,
  Text,
  VStack,
  Box,
} from "@chakra-ui/react";
import Big from "big.js";
import db from "@app/db";
import { ContractType, CovenantType, SmartToken, TxO } from "@app/types";
import { SelectableInput } from "@lib/coinSelect";
import {
  buildRoyaltyListingTx,
  royaltyTermsFromMetadata,
} from "@lib/royaltyCovenant";
import { reverseRef } from "@lib/Outpoint";
import { photonsToRXD } from "@lib/format";
import { feeRate, network, openModal, wallet } from "@app/signals";
import { electrumWorker } from "@app/electrum/Electrum";
import { updateRxdBalances } from "@app/utxos";
import {
  encodeListingDescriptor,
  recordCovenant,
  ListingDescriptor,
} from "@app/covenant";

// Decimal-safe RXD -> photons (mirrors Swap.tsx).
function rxdToPhotons(rxd: number): number {
  return Number(Big(rxd).times(100000000).round(0, 0).toString());
}

interface Props {
  glyph: SmartToken;
  txo: TxO;
  disclosure: UseDisclosureProps;
  onSuccess?: (txid: string) => void;
}

/**
 * "List with enforced royalty" — move an NFT from its plain nftScript into the
 * royalty *sale covenant* (royaltySaleScript). The terms are derived from the
 * NFT's recorded royalty (royaltyTermsFromMetadata) so a compliant wallet always
 * honours the creator's terms, and the covenant enforces them on-chain: a buyer
 * cannot strip or underpay the royalty. This is distinct from the PSRT swap flow
 * — the covenant needs no maker signature, so the listing is shareable as a
 * plain descriptor.
 */
export default function RoyaltyListModal({
  glyph,
  txo,
  disclosure,
  onSuccess,
}: Props) {
  const { isOpen, onClose } = disclosure;
  const toast = useToast();
  const [price, setPrice] = useState("");
  const [loading, setLoading] = useState(false);
  const [descriptor, setDescriptor] = useState<string>("");

  useEffect(() => {
    setPrice("");
    setLoading(false);
    setDescriptor("");
  }, [isOpen]);

  const royalty = glyph.royalty;

  const pricePhotons = (() => {
    const n = parseFloat(price);
    return Number.isFinite(n) && n > 0 ? rxdToPhotons(n) : 0;
  })();

  // Preview the royalty the covenant will commit to at this price.
  const previewTerms =
    royalty && pricePhotons > 0
      ? royaltyTermsFromMetadata({
          ref: reverseRef(glyph.ref),
          sellerAddress: wallet.value.address,
          price: pricePhotons,
          royalty,
        })
      : undefined;
  const previewRoyaltyTotal =
    previewTerms?.royalties.reduce((a, r) => a + r.value, 0) ?? 0;

  const submit = async () => {
    if (!royalty) return;
    if (pricePhotons <= 0) {
      toast({ status: "error", title: "Enter a valid price" });
      return;
    }

    if (wallet.value.locked || !wallet.value.wif) {
      openModal.value = {
        modal: "unlock",
        onClose: (unlocked) => unlocked && submit(),
      };
      return;
    }

    setLoading(true);
    try {
      const terms = royaltyTermsFromMetadata({
        ref: reverseRef(glyph.ref),
        sellerAddress: wallet.value.address,
        price: pricePhotons,
        royalty,
      });
      if (terms.royalties.length === 0) {
        toast({
          status: "error",
          title: "Royalty rounds to zero",
          description:
            "At this price the royalty is 0. Raise the price or set a minimum royalty.",
        });
        setLoading(false);
        return;
      }

      const coins: SelectableInput[] = await db.txo
        .where({ contractType: ContractType.RXD, spent: 0 })
        .toArray();

      const { tx, covenantScript } = buildRoyaltyListingTx({
        sellerAddress: wallet.value.address,
        sellerWif: wallet.value.wif.toString(),
        rxdCoins: coins,
        nftUtxo: txo,
        terms,
        feeRate: feeRate.value,
      });

      const rawTx = tx.toString();
      const broadcastTxid = await electrumWorker.value.broadcast(rawTx);
      const listTxid = broadcastTxid || tx.id;
      await db.broadcast.put({
        txid: listTxid,
        date: Date.now(),
        description: "royalty_list",
      });

      await recordCovenant({
        type: CovenantType.ROYALTY_LISTING,
        ref: glyph.ref,
        txid: listTxid,
        vout: 0,
        script: covenantScript,
        value: txo.value,
        ownerAddress: wallet.value.address,
        terms,
      });

      // The NFT left the plain nftScript; flag the glyph so it isn't sent/melted
      // while listed, and let the next sync mark it spent (it lives in the
      // marketplace now).
      await db.glyph.where({ ref: glyph.ref }).modify({ swapPending: true });

      const desc: ListingDescriptor = {
        ref: glyph.ref,
        name: glyph.name,
        covenantUtxo: {
          txid: listTxid,
          vout: 0,
          script: covenantScript,
          value: txo.value,
        },
        terms,
      };
      setDescriptor(encodeListingDescriptor(desc));

      try {
        await electrumWorker.value.manualSync();
        await updateRxdBalances(wallet.value.address);
      } catch (err) {
        console.debug("[RoyaltyList] post-list sync failed", err);
      }

      toast({ status: "success", title: "Listed with enforced royalty" });
      if (onSuccess) onSuccess(listTxid);
    } catch (error) {
      console.error(error);
      toast({
        status: "error",
        title: "Listing failed",
        description: error instanceof Error ? error.message : undefined,
      });
    }
    setLoading(false);
  };

  if (!isOpen || !onClose) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} isCentered>
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>{"List with enforced royalty"}</ModalHeader>
        <ModalCloseButton />
        <ModalBody pb={6}>
          {!royalty ? (
            <Alert status="warning">
              <AlertIcon />
              <AlertDescription>
                This token has no recorded royalty, so it can't be listed with
                an enforced royalty. Use a normal swap instead.
              </AlertDescription>
            </Alert>
          ) : descriptor ? (
            <VStack align="stretch" spacing={3}>
              <Alert status="success">
                <AlertIcon />
                <AlertDescription>
                  Listed. Share this descriptor with a buyer — they can complete
                  the purchase from “Buy a listing” on the Marketplace. The
                  covenant enforces your {royalty.bps / 100}% royalty on-chain.
                </AlertDescription>
              </Alert>
              <FormControl>
                <FormLabel>{"Listing descriptor"}</FormLabel>
                <Input
                  value={descriptor}
                  isReadOnly
                  onFocus={(e) => e.target.select()}
                  fontFamily="mono"
                  fontSize="xs"
                />
                <FormHelperText>
                  Anyone with this descriptor can buy at your committed price.
                </FormHelperText>
              </FormControl>
            </VStack>
          ) : (
            <VStack align="stretch" spacing={4}>
              <Box>
                <Text fontWeight="bold">{glyph.name || "Unnamed token"}</Text>
                <Text fontSize="sm" color="gray.400">
                  Royalty: {royalty.bps / 100}%
                  {royalty.minimum
                    ? ` (min ${photonsToRXD(royalty.minimum)} ${
                        network.value.ticker
                      })`
                    : ""}
                </Text>
              </Box>
              <FormControl>
                <FormLabel>{`Sale price (${network.value.ticker})`}</FormLabel>
                <Input
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.0"
                  min={0}
                />
                {previewTerms && (
                  <FormHelperText>
                    Buyer pays {photonsToRXD(pricePhotons)}{" "}
                    {network.value.ticker}; you receive{" "}
                    {photonsToRXD(previewTerms.price)} and the royalty recipient
                    {previewTerms.royalties.length > 1 ? "s" : ""} receive
                    {previewTerms.royalties.length > 1 ? "" : "s"}{" "}
                    {photonsToRXD(previewRoyaltyTotal)} {network.value.ticker}.
                  </FormHelperText>
                )}
              </FormControl>
              <Alert status="info" fontSize="sm">
                <AlertIcon />
                <AlertDescription>
                  The NFT moves into the royalty covenant. You can reclaim it
                  any time from the Marketplace (Cancel). A buyer cannot strip
                  or underpay the royalty.
                </AlertDescription>
              </Alert>
            </VStack>
          )}
        </ModalBody>
        <ModalFooter gap={3}>
          {descriptor || !royalty ? (
            <Button onClick={onClose}>{"Close"}</Button>
          ) : (
            <>
              <Button
                variant="primary"
                onClick={submit}
                isLoading={loading}
                isDisabled={pricePhotons <= 0}
              >
                {"List"}
              </Button>
              <Button onClick={onClose}>{"Cancel"}</Button>
            </>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
