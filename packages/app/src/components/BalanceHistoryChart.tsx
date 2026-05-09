/**
 * Balance History Chart - Visualize wallet balance over time
 */
import { useMemo } from "react";
import { Box, Text, Spinner, Alert, AlertIcon, VStack, HStack } from "@chakra-ui/react";
import { t } from "@lingui/macro";
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";
import { BroadcastResult } from "@app/types";
import dayjs from "dayjs";

interface BalancePoint {
  date: string;
  balance: number;
  txid?: string;
  type?: string;
}

export default function BalanceHistoryChart() {
  const transactions = useLiveQuery(
    () => db.broadcast.orderBy("date").reverse().toArray(),
    []
  );

  const chartData = useMemo(() => {
    if (!transactions) return [];

    const points: BalancePoint[] = [];
    let runningBalance = 0;

    // Group transactions by date and calculate running balance
    const sortedTxs = [...transactions].sort((a, b) => a.date - b.date);
    
    for (const tx of sortedTxs) {
      const dateStr = dayjs(tx.date).format("YYYY-MM-DD");
      
      // Simplified balance calculation - in real implementation would track actual UTXO changes
      // For now, we'll simulate balance changes based on transaction types
      let balanceChange = 0;
      
      if (tx.description?.includes("vault_claim")) {
        balanceChange = 1000; // Simulated vault claim amount
      } else if (tx.description?.includes("vault_create")) {
        balanceChange = -1000; // Simulated vault creation amount
      } else if (tx.description?.includes("send")) {
        balanceChange = -500; // Simulated send amount
      } else if (tx.description?.includes("mint")) {
        balanceChange = 100; // Simulated mint amount
      }
      
      runningBalance += balanceChange;
      
      points.push({
        date: dateStr,
        balance: runningBalance,
        txid: tx.txid,
        type: tx.description,
      });
    }

    // Aggregate by date to avoid too many points
    const dailyMap = new Map<string, number>();
    for (const point of points) {
      const existing = dailyMap.get(point.date) || 0;
      dailyMap.set(point.date, Math.max(existing, point.balance));
    }

    return Array.from(dailyMap.entries())
      .map(([date, balance]) => ({ date, balance }))
      .slice(-30); // Last 30 days
  }, [transactions]);

  if (!transactions) {
    return (
      <Box textAlign="center" py={8}>
        <Spinner />
        <Text mt={2}>{t`Loading balance history...`}</Text>
      </Box>
    );
  }

  if (chartData.length === 0) {
    return (
      <Alert status="info">
        <AlertIcon />
        {t`No balance history available yet. Transactions will appear here as they occur.`}
      </Alert>
    );
  }

  const maxBalance = Math.max(...chartData.map(d => d.balance));
  const minBalance = Math.min(...chartData.map(d => d.balance));

  return (
    <Box>
      <Text fontWeight="bold" mb={4}>{t`Balance History (Last 30 Days)`}</Text>
      
      {/* Simple bar chart visualization using Chakra UI */}
      <Box bg="gray.800" p={4} borderRadius="md" overflowX="auto">
        <VStack align="stretch" spacing={2}>
          {chartData.map((point, index) => {
            const heightPercent = maxBalance > 0 ? (point.balance / maxBalance) * 100 : 0;
            const isRecent = index >= chartData.length - 7;
            
            return (
              <HStack key={point.date} spacing={3} align="center">
                <Text fontSize="xs" w="60px" color="whiteAlpha.600">
                  {dayjs(point.date).format("MMM DD")}
                </Text>
                
                {/* Bar visualization */}
                <Box flex={1} h="20px" bg="gray.700" borderRadius="sm" position="relative" overflow="hidden">
                  <Box 
                    h="100%" 
                    w={`${heightPercent}%`}
                    bg={isRecent ? "blue.400" : "blue.600"}
                    borderRadius="sm"
                    transition="all 0.2s"
                  />
                </Box>
                
                <Text fontSize="xs" w="80px" textAlign="right">
                  {point.balance.toLocaleString()} RXD
                </Text>
              </HStack>
            );
          })}
        </VStack>
      </Box>
      
      <HStack mt={4} justify="space-between" fontSize="xs" color="whiteAlpha.600">
        <Text>{t`Min`}: {minBalance.toLocaleString()} RXD</Text>
        <Text>{t`Max`}: {maxBalance.toLocaleString()} RXD</Text>
      </HStack>
    </Box>
  );
}
