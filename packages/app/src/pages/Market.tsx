import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Container,
  Flex,
  Heading,
  HStack,
  Icon,
  Input,
  SimpleGrid,
  Spacer,
  Text,
  Textarea,
  useClipboard,
  useToast,
  VStack,
} from "@chakra-ui/react";
import { useLiveQuery } from "dexie-react-hooks";
import { TbRefresh } from "react-icons/tb";
import { MdSell, MdLock, MdSecurity } from "react-icons/md";
import db from "@app/db";
import {
  ContractType,
  CovenantRecord,
  CovenantStatus,
  CovenantType,
  SmartToken,
} from "@app/types";
import { SelectableInput } from "@lib/coinSelect";
import {
  buildRoyaltyCancelTx,
  buildRoyaltyPurchaseTx,
  RoyaltySaleTerms,
} from "@lib/royaltyCovenant";
import { reverseRef } from "@lib/Outpoint";
import Outpoint from "@lib/Outpoint";
import { photonsToRXD } from "@lib/format";
import ContentContainer from "@app/components/ContentContainer";
import PageHeader from "@app/components/PageHeader";
import Card from "@app/components/Card";
import ActionIcon from "@app/components/ActionIcon";
import Identifier from "@app/components/Identifier";
import {
  electrumStatus,
  feeRate,
  network,
  openModal,
  wallet,
} from "@app/signals";
import { electrumWorker } from "@app/electrum/Electrum";
import { updateRxdBalances } from "@app/utxos";
import {
  decodeListingDescriptor,
  encodeListingDescriptor,
  listingDescriptorFromCovenant,
  loading as covenantLoading,
  syncCovenants,
} from "@app/covenant";

function royaltyTotal(terms?: CovenantRecord["terms"]): number {
  return terms?.royalties.reduce((a, r) => a + r.value, 0) ?? 0;
}

function ListingRow({ cov }: { cov: CovenantRecord }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const glyph = useLiveQuery(
    () => db.glyph.where({ ref: cov.ref }).first(),
    [cov.ref]
  );
  const descriptor =
    listingDescriptorFromCovenant(cov, glyph?.name) ?? undefined;
  const descriptorStr = descriptor ? encodeListingDescriptor(descriptor) : "";
  const { onCopy, hasCopied } = useClipboard(descriptorStr);

  const cancel = async () => {
    if (wallet.value.locked || !wallet.value.wif) {
      openModal.value = { modal: "unlock" };
      return;
    }
    setBusy(true);
    try {
      const coins: SelectableInput[] = await db.txo
        .where({ contractType: ContractType.RXD, spent: 0 })
        .toArray();
      const tx = buildRoyaltyCancelTx({
        sellerAddress: wallet.value.address,
        sellerWif: wallet.value.wif.toString(),
        rxdCoins: coins,
        covenantUtxo: {
          txid: cov.txid,
          vout: cov.vout,
          script: cov.script,
          value: cov.value,
        },
        ref: reverseRef(cov.ref),
        feeRate: feeRate.value,
      });
      const txid =
        (await electrumWorker.value.broadcast(tx.toString())) || tx.id;
      await db.broadcast.put({
        txid,
        date: Date.now(),
        description: "royalty_cancel",
      });
      if (cov.id) {
        await db.covenant.update(cov.id, { status: CovenantStatus.RESOLVED });
      }
      await db.glyph.where({ ref: cov.ref }).modify({ swapPending: false });
      try {
        await electrumWorker.value.manualSync();
        await updateRxdBalances(wallet.value.address);
      } catch (err) {
        console.debug("[Market] post-cancel sync failed", err);
      }
      toast({ status: "success", title: "Listing cancelled — NFT reclaimed" });
    } catch (error) {
      console.error(error);
      toast({
        status: "error",
        title: "Cancel failed",
        description: error instanceof Error ? error.message : undefined,
      });
    }
    setBusy(false);
  };

  return (
    <Card p={4}>
      <Flex align="center" gap={3} wrap="wrap">
        <Box flex={1} minW="200px">
          <Text fontWeight="bold">{glyph?.name || "Unnamed token"}</Text>
          <Identifier>{Outpoint.fromString(cov.ref).shortRef()}</Identifier>
          <Text fontSize="sm" color="gray.400" mt={1}>
            Price {photonsToRXD(cov.terms?.price ?? 0)} {network.value.ticker} ·
            Royalty {photonsToRXD(royaltyTotal(cov.terms))}{" "}
            {network.value.ticker}
          </Text>
        </Box>
        <HStack>
          <Button size="sm" onClick={onCopy} isDisabled={!descriptorStr}>
            {hasCopied ? "Copied" : "Copy descriptor"}
          </Button>
          <Button size="sm" onClick={cancel} isLoading={busy}>
            Cancel
          </Button>
        </HStack>
      </Flex>
    </Card>
  );
}

function CovenantTokenRow({ cov }: { cov: CovenantRecord }) {
  const glyph = useLiveQuery(
    () => db.glyph.where({ ref: cov.ref }).first(),
    [cov.ref]
  ) as SmartToken | undefined;
  const isSoulbound = cov.type === CovenantType.SOULBOUND;
  return (
    <Card p={4}>
      <Flex align="center" gap={3}>
        <Icon as={isSoulbound ? MdLock : MdSecurity} boxSize={5} />
        <Box flex={1}>
          <Text fontWeight="bold">{glyph?.name || "Unnamed token"}</Text>
          <Identifier>{Outpoint.fromString(cov.ref).shortRef()}</Identifier>
        </Box>
        <Text fontSize="sm" color="gray.400">
          {isSoulbound ? "Soulbound" : "Authority-gated"}
        </Text>
      </Flex>
    </Card>
  );
}

export default function Market() {
  const toast = useToast();
  const [buyInput, setBuyInput] = useState("");
  const [buying, setBuying] = useState(false);

  const listings = useLiveQuery(
    () =>
      db.covenant
        .where({ status: CovenantStatus.ACTIVE })
        .filter((c) => c.type === CovenantType.ROYALTY_LISTING)
        .toArray(),
    [],
    []
  );
  const covenantTokens = useLiveQuery(
    () =>
      db.covenant
        .where({ status: CovenantStatus.ACTIVE })
        .filter((c) => c.type !== CovenantType.ROYALTY_LISTING)
        .toArray(),
    [],
    []
  );

  useEffect(() => {
    syncCovenants();
  }, [electrumStatus.value]);

  const buy = async () => {
    let descriptor;
    try {
      descriptor = decodeListingDescriptor(buyInput);
    } catch {
      toast({ status: "error", title: "Invalid listing descriptor" });
      return;
    }
    if (wallet.value.locked || !wallet.value.wif) {
      openModal.value = { modal: "unlock", onClose: (u) => u && buy() };
      return;
    }
    setBuying(true);
    try {
      const coins: SelectableInput[] = await db.txo
        .where({ contractType: ContractType.RXD, spent: 0 })
        .toArray();
      const tx = buildRoyaltyPurchaseTx({
        buyerAddress: wallet.value.address,
        buyerWif: wallet.value.wif.toString(),
        buyerCoins: coins,
        covenantUtxo: descriptor.covenantUtxo,
        terms: descriptor.terms as RoyaltySaleTerms,
        feeRate: feeRate.value,
      });
      const txid =
        (await electrumWorker.value.broadcast(tx.toString())) || tx.id;
      await db.broadcast.put({
        txid,
        date: Date.now(),
        description: "royalty_buy",
      });
      // If we happen to hold this listing locally (e.g. self-buy in testing),
      // resolve it so it leaves "My Listings".
      const local = await db.covenant
        .where("[txid+vout]")
        .equals([descriptor.covenantUtxo.txid, descriptor.covenantUtxo.vout])
        .first()
        .catch(() => undefined);
      if (local?.id) {
        await db.covenant.update(local.id, { status: CovenantStatus.RESOLVED });
      }
      try {
        await electrumWorker.value.manualSync();
        await updateRxdBalances(wallet.value.address);
      } catch (err) {
        console.debug("[Market] post-buy sync failed", err);
      }
      setBuyInput("");
      toast({
        status: "success",
        title: "Purchased — royalty paid to creator on-chain",
      });
    } catch (error) {
      console.error(error);
      toast({
        status: "error",
        title: "Purchase failed",
        description: error instanceof Error ? error.message : undefined,
      });
    }
    setBuying(false);
  };

  return (
    <ContentContainer>
      <PageHeader
        toolbar={
          <Button
            size="sm"
            onClick={() => syncCovenants()}
            isLoading={covenantLoading.value}
            leftIcon={<ActionIcon as={TbRefresh} />}
          >
            Refresh
          </Button>
        }
      >
        Marketplace
      </PageHeader>

      <Container maxW="container.xl" px={4}>
        <VStack align="stretch" spacing={8}>
          <Box>
            <Heading
              size="md"
              mb={3}
              display="flex"
              alignItems="center"
              gap={2}
            >
              <Icon as={MdSell} /> My Listings
            </Heading>
            {listings?.length ? (
              <SimpleGrid columns={1} gap={3}>
                {listings.map((cov) => (
                  <ListingRow key={cov.id} cov={cov} />
                ))}
              </SimpleGrid>
            ) : (
              <Card p={4}>No active listings.</Card>
            )}
          </Box>

          <Box>
            <Heading size="md" mb={3}>
              Buy a listing
            </Heading>
            <Card p={4}>
              <VStack align="stretch" spacing={3}>
                <Text fontSize="sm" color="gray.400">
                  Paste a listing descriptor shared by a seller. The royalty
                  covenant enforces the seller's committed price and royalty
                  on-chain — no maker signature is needed.
                </Text>
                <Textarea
                  value={buyInput}
                  onChange={(e) => setBuyInput(e.target.value)}
                  placeholder="Listing descriptor"
                  fontFamily="mono"
                  fontSize="xs"
                  rows={3}
                />
                <Flex>
                  <Spacer />
                  <Button
                    variant="primary"
                    onClick={buy}
                    isLoading={buying}
                    isDisabled={!buyInput.trim()}
                  >
                    Buy
                  </Button>
                </Flex>
              </VStack>
            </Card>
          </Box>

          {covenantTokens && covenantTokens.length > 0 && (
            <Box>
              <Heading size="md" mb={3}>
                Covenant tokens
              </Heading>
              <Text fontSize="sm" color="gray.400" mb={3}>
                Soulbound and authority-gated tokens rest in covenant scripts
                the indexer doesn't list by owner yet, so they are tracked here.
              </Text>
              <SimpleGrid columns={1} gap={3}>
                {covenantTokens.map((cov) => (
                  <CovenantTokenRow key={cov.id} cov={cov} />
                ))}
              </SimpleGrid>
            </Box>
          )}
        </VStack>
      </Container>
    </ContentContainer>
  );
}
