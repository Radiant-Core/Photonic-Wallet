import { useEffect } from "react";
import db from "@app/db";
import { SwapStatus } from "@app/types";
import { Container } from "@chakra-ui/react";
import { useLiveQuery } from "dexie-react-hooks";
import SwapTable from "@app/components/SwapTable";
import NoContent from "@app/components/NoContent";
import { syncSwaps } from "@app/swap";
import { electrumStatus } from "@app/signals";
import { TbChecks } from "react-icons/tb";

export default function SwapCompleted() {
  const completed = useLiveQuery(() =>
    db.swap.where({ status: SwapStatus.COMPLETE }).toArray()
  );

  useEffect(() => {
    syncSwaps();
  }, [electrumStatus.value]);

  return (
    <Container maxW="container.xl" px={4} gap={8}>
      {completed?.length ? (
        <SwapTable swaps={completed} />
      ) : (
        <NoContent
          icon={TbChecks}
          subtitle="Swaps that have settled on-chain will be listed here."
        >
          There are no completed swaps
        </NoContent>
      )}
    </Container>
  );
}
