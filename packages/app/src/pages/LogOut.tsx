import db from "@app/db";
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Button,
  Container,
  Flex,
  Heading,
  Text,
} from "@chakra-ui/react";
import Card from "@app/components/Card";
import opfs from "@app/opfs";
import { lockWallet } from "@app/wallet";

/** Keys to clear from localStorage on logout */
const LOCAL_STORAGE_KEYS_TO_CLEAR = [
  "glyph_timelock_reveals",
  "photonic.swap.rpcConfig",
  "waveCachedNames",
  "waveRecentLookups",
  "activity-last-seen",
  "photonic_nft_storage_api_key",
  "photonic_ipfs_gateway",
];

export default function LogOut() {
  const logout = async () => {
    // R4: wipe the in-memory secret bytes BEFORE clearing storage so a
    // memory dump captured during the (brief) deletion window has no
    // recoverable mnemonic/WIF.
    lockWallet();
    await db.delete();
    await opfs.deleteAll();

    // Clear sensitive localStorage keys
    for (const key of LOCAL_STORAGE_KEYS_TO_CLEAR) {
      localStorage.removeItem(key);
    }

    // Broadcast logout to other tabs so they also lock
    try {
      const bc = new BroadcastChannel("photonic-wallet");
      bc.postMessage({ type: "logout" });
      bc.close();
    } catch {
      // BroadcastChannel not supported, ignore
    }

    document.location = "/";
  };

  return (
    <Container maxW="container.md">
      <Card gap={5}>
        <Heading textStyle="h3">{"Log out"}</Heading>
        <Text textStyle="body" color="text.secondary">
          {
            "Logging out will remove your wallet and all saved data from your browser."
          }
        </Text>
        <Alert status="error">
          <AlertIcon />
          <AlertDescription>
            {
              "Ensure you have saved your recovery phrase before logging out! Your recovery phrase is the only way you can recreate your wallet."
            }
          </AlertDescription>
        </Alert>
        <Flex justifyContent="center" pt={2}>
          <Button
            variant="primary"
            size="lg"
            w="240px"
            maxW="100%"
            onClick={logout}
          >
            {"Log out"}
          </Button>
        </Flex>
      </Card>
    </Container>
  );
}
