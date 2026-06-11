import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  IconButton,
  Input,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  useToast,
} from "@chakra-ui/react";
import { DeleteIcon } from "@chakra-ui/icons";
import { useLiveQuery } from "dexie-react-hooks";
import {
  listTracked,
  openMarketByCreateTxid,
  trackMarket,
  untrackMarket,
} from "@app/predict/predict";

export default function Predict() {
  const toast = useToast();
  const [txid, setTxid] = useState("");
  const [importing, setImporting] = useState(false);
  const markets = useLiveQuery(listTracked, [], []);

  const importMarket = async () => {
    if (!/^[0-9a-fA-F]{64}$/.test(txid.trim())) {
      toast({ title: "Enter a 64-character creation txid", status: "warning" });
      return;
    }
    setImporting(true);
    try {
      const t = await openMarketByCreateTxid(txid);
      await trackMarket(t);
      setTxid("");
      toast({ title: "Market imported", status: "success" });
    } catch (e) {
      toast({
        title: "Import failed",
        description: (e as Error).message,
        status: "error",
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <Box mx={{ base: 2, md: 4 }}>
      <Alert status="info" mb={4} borderRadius="md">
        <AlertIcon />
        Binary prediction markets, fully collateralized on-chain. Markets are
        tracked locally — import one with its creation txid, or create your
        own.
      </Alert>

      <Flex gap={2} mb={6} maxW="2xl">
        <Input
          placeholder="Market creation txid"
          fontFamily="mono"
          value={txid}
          onChange={(e) => setTxid(e.target.value)}
        />
        <Button onClick={importMarket} isLoading={importing} minW="24">
          Import
        </Button>
      </Flex>

      {markets.length === 0 ? (
        <Text color="gray.400" px={2}>
          No markets tracked yet.
        </Text>
      ) : (
        <Table size={{ base: "sm", xl: "md" }}>
          <Thead>
            <Tr>
              <Th>Question</Th>
              <Th>Expiry</Th>
              <Th>Oracle</Th>
              <Th width="50px" />
            </Tr>
          </Thead>
          <Tbody>
            {markets.map((m) => (
              <Tr key={m.createTxid}>
                <Td>
                  <Link to={`/predict/m/${m.createTxid}`}>
                    <Text fontWeight="semibold" _hover={{ color: "lightBlue.400" }}>
                      {m.question}
                    </Text>
                    <Text fontFamily="mono" fontSize="xs" color="gray.500">
                      {m.createTxid.substring(0, 8)}…
                    </Text>
                  </Link>
                </Td>
                <Td>block {m.expiry.toLocaleString()}</Td>
                <Td>
                  <Badge fontSize="xs">
                    {parseInt(m.oracle.substring(0, 2), 16)}-of-N committee
                  </Badge>
                </Td>
                <Td>
                  <IconButton
                    aria-label="Untrack market"
                    size="sm"
                    variant="ghost"
                    icon={<DeleteIcon />}
                    onClick={() => untrackMarket(m.createTxid)}
                  />
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Box>
  );
}
