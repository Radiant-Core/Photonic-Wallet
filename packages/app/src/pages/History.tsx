import { Box, VStack, HStack, Text, Table, Thead, Tbody, Tr, Th, Td, Badge, Link, Select, Spinner, Alert, AlertIcon } from "@chakra-ui/react";
import { t } from "@lingui/macro";
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";
import { wallet } from "@app/signals";
import ContentContainer from "@app/components/ContentContainer";
import PageHeader from "@app/components/PageHeader";
import createExplorerUrl from "@app/network/createExplorerUrl";
import BalanceHistoryChart from "@app/components/BalanceHistoryChart";
import { useState, useMemo } from "react";

const typeColors: Record<string, string> = {
  vault_create: "purple", vault_claim: "green", vault_vesting: "blue",
  rxd_swap: "orange", swap_cancel: "red", authority_commit: "cyan",
  authority_reveal: "teal", wave_name_commit: "pink", wave_name_reveal: "pink",
};

function classify(desc: string): string {
  if (desc.includes("vault_create")) return "vault_create";
  if (desc.includes("vault_claim")) return "vault_claim";
  if (desc.includes("vault_vesting")) return "vault_vesting";
  if (desc.includes("swap_cancel")) return "swap_cancel";
  if (desc.includes("swap")) return "rxd_swap";
  if (desc.includes("authority")) return desc.includes("commit") ? "authority_commit" : "authority_reveal";
  if (desc.includes("wave_name")) return desc.includes("commit") ? "wave_name_commit" : "wave_name_reveal";
  return desc;
}

interface ActivityItem {
  id: string;
  type: string;
  txid: string;
  timestamp: number;
  description: string;
}

export default function HistoryPage() {
  const [filter, setFilter] = useState("all");
  const broadcasts = useLiveQuery(() => db.broadcast.orderBy("date").reverse().toArray(), []);

  const activities: ActivityItem[] = useMemo(() => {
    if (!broadcasts) return [];
    return broadcasts.map((b) => ({ 
      id: b.txid, 
      type: classify(b.description), 
      txid: b.txid, 
      timestamp: b.date, 
      description: b.description 
    }));
  }, [broadcasts]);

  const filtered = useMemo(() => {
    if (filter === "all") return activities;
    return activities.filter((a) => a.type === filter);
  }, [activities, filter]);

  if (!broadcasts) {
    return (
      <ContentContainer>
        <PageHeader>{t`Activity History`}</PageHeader>
        <Box textAlign="center" py={8}><Spinner /></Box>
      </ContentContainer>
    );
  }

  return (
    <ContentContainer>
      <PageHeader>{t`Activity History`}</PageHeader>
      {!wallet.value.address ? (
        <Alert status="warning"><AlertIcon />{t`Please unlock your wallet to view activity history`}</Alert>
      ) : broadcasts.length === 0 ? (
        <Alert status="info"><AlertIcon />{t`No activity recorded yet`}</Alert>
      ) : (
        <VStack align="stretch" spacing={6}>
          <BalanceHistoryChart />
          <Box>
            <Text mb={3}>{broadcasts.length} transactions recorded</Text>
            <Table>
            <Thead>
              <Tr>
                <Th>Type</Th>
                <Th>Timestamp</Th>
                <Th>TXID</Th>
              </Tr>
            </Thead>
            <Tbody>
              {filtered.map((a) => (
                <Tr key={a.id}>
                  <Td><Badge colorScheme={typeColors[a.type]||"gray"}>{a.type}</Badge></Td>
                  <Td fontSize="xs">{new Date(a.timestamp).toLocaleString()}</Td>
                  <Td><Link href={createExplorerUrl(a.txid)} isExternal color="blue.400">{a.txid.slice(0,12)}...</Link></Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
          </Box>
        </VStack>
      )}
    </ContentContainer>
  );
}
