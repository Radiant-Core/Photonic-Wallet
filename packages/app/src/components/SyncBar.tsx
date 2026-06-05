import { Box, Progress, SimpleGrid } from "@chakra-ui/react";
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";

export default function SyncBar() {
  const subs = useLiveQuery(() =>
    db.subscriptionStatus.filter((v) => !v.sync.done).toArray()
  );
  const errors = useLiveQuery(() =>
    db.subscriptionStatus.filter((v) => v.sync.error === true).toArray()
  );

  if (!subs?.length && !errors?.length) return null;

  const sum = subs?.reduce(
    (acc, { sync }) => ({
      numSynced: (sync.numSynced || 0) + acc.numSynced,
      numTotal: (sync.numTotal || 0) + acc.numSynced,
    }),
    {
      numSynced: 0,
      numTotal: 0,
    }
  );

  return (
    <SimpleGrid py={4} borderTopWidth={1} borderTopColor="whiteAlpha.100">
      {sum && (
        <Box px={6} py={2} color="whiteAlpha.700">
          Syncing
          {!sum.numTotal || sum.numSynced === undefined ? (
            <Progress my={2} isIndeterminate size="xs" />
          ) : (
            <Progress
              my={2}
              size="xs"
              hasStripe
              isAnimated
              value={(sum.numSynced / sum.numTotal) * 100}
            />
          )}
        </Box>
      )}
      {!!errors?.length && (
        // A failed subscription is usually a transient server hiccup (a slow
        // status response under load) and the wallet keeps retrying in the
        // background, so present it as a soft "reconnecting" state rather than a
        // hard error. Balances still update via the listunspent fallback.
        <Box px={6} py={2} color="whiteAlpha.600">
          Reconnecting…
          <Progress my={2} isIndeterminate size="xs" />
        </Box>
      )}
    </SimpleGrid>
  );
}
