import db from "@app/db";
import { ContractType, ElectrumStatus, SwapError } from "@app/types";
import {
  Box,
  Button,
  Container,
  Icon,
  Image,
  Spinner,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  useToast,
} from "@chakra-ui/react";
import { useLiveQuery } from "dexie-react-hooks";
import NoContent from "@app/components/NoContent";
import { electrumWorker } from "@app/electrum/Electrum";
import { electrumStatus, openModal, wallet } from "@app/signals";
import { useEffect, useState } from "react";
import { ElectrumUtxo } from "@lib/types";
import { CheckIcon, ExternalLinkIcon } from "@chakra-ui/icons";
import createExplorerUrl from "@app/network/createExplorerUrl";
import rxdIcon from "/rxd.png";
import TokenContent from "@app/components/TokenContent";
import { TbQuestionMark } from "react-icons/tb";
import Outpoint from "@lib/Outpoint";
import Identifier from "@app/components/Identifier";
import { cancelSwap } from "@app/swap";

function SwapDetail({ utxo }: { utxo: ElectrumUtxo }) {
  const ref = utxo.refs?.[0];
  if (ref?.ref) {
    return <GlyphIcon tokenRef={ref} />;
  } else {
    return (
      <>
        <Td>
          <Image src={rxdIcon} width={6} height={6} />
        </Td>
        <Td>n/a </Td>
      </>
    );
  }
}

function GlyphIcon({
  tokenRef,
}: {
  tokenRef: { ref: string; type: "normal" | "single" };
}) {
  const ref = Outpoint.fromShortInput(tokenRef.ref);
  const glyph = useLiveQuery(() =>
    db.glyph.where({ ref: ref.toString() }).first()
  );

  return (
    <>
      {glyph ? (
        <Td>
          <Box w={6} h={6}>
            <TokenContent glyph={glyph} thumbnail />
          </Box>
        </Td>
      ) : (
        <Td>
          <Icon as={TbQuestionMark} boxSize={6} />
        </Td>
      )}
      <Td>
        <Identifier showCopy copyValue={ref.ref()}>
          {ref.shortRef()}
        </Identifier>
      </Td>
    </>
  );
}

export default function SwapMissing() {
  const [done, setDone] = useState<string[]>([]);
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState<
    { contractType: ContractType; utxo: ElectrumUtxo }[] | null
  >(null);

  useEffect(() => {
    (async () => {
      if (electrumStatus.value !== ElectrumStatus.CONNECTED) return;
      const result = await electrumWorker.value.findSwaps(
        wallet.value.swapAddress
      );
      const counts = await Promise.all(
        result.map(async (value) => {
          return [
            await db.swap.where({ txid: value.utxo.tx_hash }).count(),
            value,
          ];
        })
      );
      const filtered = counts
        .filter(([count]) => count === 0)
        .map(([, utxo]) => utxo) as {
        contractType: ContractType;
        utxo: ElectrumUtxo;
      }[];
      setMissing(filtered);
      setLoading(false);
    })();
  }, [electrumStatus.value]);

  const cancel = async (utxo: ElectrumUtxo, contractType: ContractType) => {
    if (wallet.value.locked) {
      openModal.value = {
        modal: "unlock",
      };
      return;
    }

    try {
      const ref = utxo.refs?.[0]?.ref;
      await cancelSwap(
        contractType,
        utxo.tx_hash,
        utxo.value,
        ref ? Outpoint.fromShortInput(ref).toString() : undefined,
        utxo.tx_pos
      );
    } catch (error) {
      console.debug(error);
      if (error instanceof SwapError) {
        toast({ status: "error", title: error.message });
      } else {
        toast({ status: "error", title: "Failed to cancel" });
      }
      return;
    }
    setDone([...done, utxo.tx_hash]);
    toast({ status: "success", title: "Swap cancelled" });
  };

  if (loading) {
    return (
      <Container
        maxW="container.xl"
        p={16}
        display="flex"
        gap={8}
        justifyContent="center"
      >
        <Spinner />
      </Container>
    );
  }

  return (
    <Container maxW="container.xl" px={4} gap={8}>
      {missing?.length ? (
        <Table size={{ base: "sm", xl: "md" }}>
          <Thead>
            <Tr bg="surface.sunken">
              <Th display={{ base: "none", lg: "table-cell" }} />
              <Th textStyle="label">{"TX ID"}</Th>
              <Th textStyle="label">{"Swap"}</Th>
              <Th textStyle="label">{"Radiant ID"}</Th>
              <Th textStyle="label">{"Value"}</Th>
              <Th textStyle="label">{"Actions"}</Th>
              <Th width="50px" />
              <Th display={{ base: "none", lg: "table-cell" }} />
            </Tr>
          </Thead>
          <Tbody fontFamily="mono">
            {missing?.map(({ utxo, contractType }) => (
              <Tr
                key={utxo.tx_hash}
                borderBottomWidth="1px"
                borderColor="border.subtle"
                transition="background 0.12s"
                _hover={{ bg: "bg.50" }}
              >
                <Td display={{ base: "none", lg: "table-cell" }} />
                <Td>
                  <Identifier showCopy copyValue={utxo.tx_hash}>
                    {utxo.tx_hash.substring(0, 4)}…
                    {utxo.tx_hash.substring(60, 64)}
                  </Identifier>
                </Td>
                <SwapDetail utxo={utxo} />
                <Td sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {utxo.value}
                </Td>
                <Td>
                  {!done.includes(utxo.tx_hash) ? (
                    // TODO this can be done a better way
                    <Button
                      size="sm"
                      onClick={() => cancel(utxo, contractType)}
                    >
                      Cancel
                    </Button>
                  ) : (
                    <CheckIcon boxSize={8} color="green.400" />
                  )}
                </Td>
                <Td>
                  <a href={createExplorerUrl(utxo.tx_hash)} target="_blank">
                    <ExternalLinkIcon />
                  </a>
                </Td>
                <Td display={{ base: "none", lg: "table-cell" }} />
              </Tr>
            ))}
          </Tbody>
        </Table>
      ) : (
        <NoContent
          icon={TbQuestionMark}
          subtitle="Any Radiant or tokens sent to your swap address which aren't found in the database can be recovered here."
        >
          There are no missing swaps
        </NoContent>
      )}
    </Container>
  );
}
