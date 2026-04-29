import React, { useState, useMemo } from "react";
import { EncryptionProgress } from "./EncryptionProgress";
import type { EncryptionProgress as ProgressType } from "@app/encryptionService";
import {
  Box,
  VStack,
  HStack,
  FormControl,
  FormLabel,
  Input,
  Button,
  Text,
  Alert,
  AlertIcon,
  AlertDescription,
  Tabs,
  TabList,
  Tab,
  TabPanels,
  TabPanel,
  useToast,
  Icon,
  Divider,
} from "@chakra-ui/react";
import { MdLock, MdLockOpen, MdTimer, MdKey, MdPublic } from "react-icons/md";
import { Trans, t } from "@lingui/macro";
import {
  formatTimeRemaining,
  getReveal,
  deleteReveal,
  type TimelockReveal,
} from "@lib/timelock";
import { buildRevealTx } from "@lib/reveal";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { GLYPH_TIMELOCK } from "@lib/protocols";
import {
  type EncryptedContentStub,
  decryptContent,
  retrieveEncryptedContent,
  deriveLocatorKeyFromPassphrase,
} from "@app/encryptionService";
import { StorageManager } from "@lib/storage";
import { wallet, feeRate } from "@app/signals";
import { deriveEncryptionKeypair } from "@app/keys";
import { deriveKeyHKDF, unwrapCEK } from "@lib/encryption";
import db from "@app/db";
import { useLiveQuery } from "dexie-react-hooks";
import { ContractType } from "@app/types";
import { electrumWorker } from "@app/electrum/Electrum";

type EncryptedContentUnlockProps = {
  /** On-chain encrypted metadata stub (from token's crypto field) */
  stub: EncryptedContentStub;
  /** Encrypted locator (base64) from payload.crypto.locator — present for off-chain backends */
  locator?: string;
  /** Locator nonce (base64) from payload.crypto.locator_nonce — present for off-chain backends */
  locatorNonce?: string;
  /** Hex-encoded ciphertext from main.b — present for on-chain (glyph) storage */
  mainB?: string;
  /** Token ref ("txid:vout") — required for the publish-reveal flow */
  tokenRef?: string;
  onDecrypted: (plaintext: Uint8Array) => void;
};

/**
 * Build a StorageManager with all adapters registered so downloadEncrypted
 * can route to whichever backend the locator specifies.
 */
function makeStorageManager(): StorageManager {
  return new StorageManager({
    defaultAdapter: "arweave",
    local: { maxSize: 10 * 1024 * 1024 },
    backend: { baseUrl: import.meta.env.VITE_BACKEND_URL || "" },
    ipfs: { apiKey: import.meta.env.VITE_NFT_STORAGE_TOKEN || "" },
    glyph: { maxSizeBytes: 512 * 1024 },
  });
}

export default function EncryptedContentUnlock({
  stub,
  locator,
  locatorNonce,
  mainB,
  tokenRef,
  onDecrypted,
}: EncryptedContentUnlockProps) {
  const [password, setPassword] = useState("");
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [isRevealing, setIsRevealing] = useState(false);
  const [decryptProgress, setDecryptProgress] = useState<ProgressType | null>(null);
  // Local reveal record (CEK saved at mint time) — only the original minter has this
  const [savedReveal, setSavedReveal] = useState<TimelockReveal | undefined>(() =>
    tokenRef ? getReveal(tokenRef) : undefined
  );

  // Crash-safe broadcast check: if the app crashed after broadcasting but before
  // deleteReveal ran, the txid is in db.broadcast with description 'timelock_reveal'.
  // When found, clean up the stale localStorage entry proactively.
  const revealAlreadyBroadcast = useLiveQuery(async () => {
    if (!savedReveal || !tokenRef) return false;
    const rows = await db.broadcast
      .where("txid")
      .above("")
      .filter((r) => r.description === "timelock_reveal")
      .toArray();
    const found = rows.length > 0;
    if (found && getReveal(tokenRef)) {
      deleteReveal(tokenRef);
      setSavedReveal(undefined);
    }
    return found;
  }, [savedReveal, tokenRef], false);
  const toast = useToast();

  const isTimelocked = stub.crypto?.timelock !== undefined && stub.p?.includes(GLYPH_TIMELOCK);
  const unlockAt = stub.crypto?.timelock?.unlock_at;
  const now = Date.now() / 1000;
  const timelockExpired = !isTimelocked || (unlockAt !== undefined && now >= unlockAt);
  const timeRemaining = unlockAt ? Math.max(0, unlockAt - now) : 0;
  const hint = stub.crypto?.timelock?.hint;
  const scheme = stub.main?.scheme || "xchacha20poly1305";

  const walletMnemonic = wallet.value.mnemonic;

  /**
   * Pre-check: probe whether the wallet's X25519 key can unwrap any recipient slot.
   * unwrapCEK is synchronous (X25519 DH + HKDF) — no scrypt, no network.
   * Result is memoized so it only re-runs when the wallet mnemonic or stub changes.
   */
  const isWalletKeyRecipient = useMemo((): boolean => {
    if (!walletMnemonic) return false;
    const recipients = stub.crypto?.recipients;
    if (!recipients?.length) return false;
    try {
      const keypair = deriveEncryptionKeypair(walletMnemonic);
      const recipientKeyPair = {
        x25519PrivateKey: keypair.x25519PrivateKey,
        x25519PublicKey: keypair.x25519PublicKey,
      };
      for (const r of recipients) {
        const ephemeralBytes = new Uint8Array(Buffer.from(r.ephemeral_x25519, "base64"));
        if (ephemeralBytes.every((b) => b === 0)) continue; // passphrase sentinel
        try {
          const ephemeral = {
            x25519EphemeralPublicKey: ephemeralBytes,
            ...(r.ephemeral_pq
              ? { mlkemCiphertext: new Uint8Array(Buffer.from(r.ephemeral_pq, "base64")) }
              : {}),
          };
          unwrapCEK(
            new Uint8Array(Buffer.from(r.kek, "base64")),
            ephemeral,
            recipientKeyPair
          );
          return true; // unwrap succeeded — this wallet is a recipient
        } catch {
          // not this recipient slot, keep trying
        }
      }
    } catch {
      // keypair derivation failed (shouldn't happen with valid mnemonic)
    }
    return false;
  }, [walletMnemonic, stub]);

  const canUseWalletKey = !!walletMnemonic && !wallet.value.locked && isWalletKeyRecipient;

  /** True when content is stored on-chain (main.b present, no locator needed) */
  const isOnChain = !!mainB && !locator;

  const assertStorageAvailable = (): boolean => {
    if (!isOnChain && (!locator || !locatorNonce)) {
      toast({
        title: t`Storage Locator Missing`,
        description: t`Cannot retrieve encrypted blob — locator not found in token metadata`,
        status: "error",
        duration: 6000,
      });
      return false;
    }
    return true;
  };

  /**
   * Fetch and decrypt content from off-chain storage (IPFS / Arweave / Wallet Backend).
   * The StorageManager decrypts the locator to discover which adapter to use.
   */
  const fetchAndDecryptOffChain = async (
    locatorKey: Uint8Array,
    decryptOptions: Parameters<typeof decryptContent>[1]
  ): Promise<void> => {
    const storageManager = makeStorageManager();
    const locatorBytes = new Uint8Array(Buffer.from(locator!, "base64"));
    const locatorNonceBytes = new Uint8Array(Buffer.from(locatorNonce!, "base64"));

    const encryptedBlob = await retrieveEncryptedContent(
      locatorBytes,
      locatorNonceBytes,
      locatorKey,
      storageManager
    );

    const plaintext = await decryptContent(encryptedBlob, decryptOptions, (p) =>
      setDecryptProgress({ stage: p.stage as ProgressType["stage"], loaded: p.loaded, total: p.total, percent: p.percent })
    );

    toast({
      title: t`Content Decrypted!`,
      description: t`Successfully unlocked encrypted content`,
      status: "success",
    });
    onDecrypted(plaintext);
    setPassword("");
  };

  /**
   * Fetch and decrypt content stored on-chain in main.b (glyph backend).
   * The hex ciphertext is embedded directly in the NFT metadata — no network
   * fetch required.
   */
  const fetchAndDecryptOnChain = async (
    decryptOptions: Parameters<typeof decryptContent>[1]
  ): Promise<void> => {
    if (!mainB) throw new Error("On-chain ciphertext (main.b) is missing");

    const encryptedBlob = hexToBytes(mainB);

    // Verify hash matches expected before decrypting
    const { sha256: sha256fn } = await import("@noble/hashes/sha256");
    const actualHash = sha256fn(encryptedBlob);
    const expectedHashHex = stub.main?.hash?.replace("sha256:", "");
    if (expectedHashHex && bytesToHex(actualHash) !== expectedHashHex) {
      throw new Error("On-chain ciphertext hash mismatch — data may be corrupted");
    }

    const plaintext = await decryptContent(encryptedBlob, decryptOptions, (p) =>
      setDecryptProgress({ stage: p.stage as ProgressType["stage"], loaded: p.loaded, total: p.total, percent: p.percent })
    );

    toast({
      title: t`Content Decrypted!`,
      description: t`Successfully unlocked encrypted content`,
      status: "success",
    });
    onDecrypted(plaintext);
    setPassword("");
  };

  /** Dispatch to the correct fetch+decrypt path based on storage type */
  const fetchAndDecrypt = async (
    locatorKey: Uint8Array | undefined,
    decryptOptions: Parameters<typeof decryptContent>[1]
  ): Promise<void> => {
    if (isOnChain) {
      await fetchAndDecryptOnChain(decryptOptions);
    } else {
      await fetchAndDecryptOffChain(locatorKey!, decryptOptions);
    }
  };

  /** Passphrase mode: user types password */
  const handlePassphraseDecrypt = async () => {
    if (!password) {
      toast({
        title: t`Password Required`,
        description: t`Please enter the decryption password`,
        status: "warning",
      });
      return;
    }
    if (!assertStorageAvailable()) return;

    setIsDecrypting(true);
    setDecryptProgress(null);
    try {
      const locatorKey = isOnChain
        ? undefined // unused for on-chain path
        : deriveLocatorKeyFromPassphrase(password, stub);
      await fetchAndDecrypt(locatorKey, { metadata: stub, passphrase: password });
    } catch (error) {
      console.error("Passphrase decryption error:", error);
      toast({
        title: t`Decryption Failed`,
        description: t`Invalid password or corrupted content`,
        status: "error",
        duration: 5000,
      });
    } finally {
      setIsDecrypting(false);
    }
  };

  /** Wallet key mode: derive X25519 keypair from HD wallet (m/44'/0'/0'/2/0) */
  const handleWalletKeyDecrypt = async () => {
    if (!assertStorageAvailable()) return;
    if (!walletMnemonic) {
      toast({
        title: t`Wallet Locked`,
        description: t`Unlock your wallet first to use your encryption key`,
        status: "warning",
      });
      return;
    }

    setIsDecrypting(true);
    setDecryptProgress(null);
    try {
      const keypair = deriveEncryptionKeypair(walletMnemonic);

      // Derive locatorKey from the wallet's X25519 private key (recipient mode)
      const locatorKey = isOnChain
        ? undefined
        : deriveKeyHKDF(
            keypair.x25519PrivateKey,
            new Uint8Array(0),
            new TextEncoder().encode("glyph-locator-recipient-v1"),
            32
          );

      await fetchAndDecrypt(locatorKey, {
        metadata: stub,
        privateKey: keypair.x25519PrivateKey,
      });
    } catch (error) {
      console.error("Wallet key decryption error:", error);
      toast({
        title: t`Decryption Failed`,
        description: t`Your wallet key is not a recipient for this content`,
        status: "error",
        duration: 5000,
      });
    } finally {
      setIsDecrypting(false);
    }
  };

  /**
   * Publish reveal mode: broadcast the saved CEK on-chain via an OP_RETURN
   * reveal transaction so anyone can decrypt the timelocked content.
   * Only available to the original minter (who has the CEK in localStorage).
   */
  const handlePublishReveal = async () => {
    if (!savedReveal || !tokenRef) {
      toast({
        title: t`No Reveal Available`,
        description: t`No saved CEK was found for this token.`,
        status: "warning",
      });
      return;
    }
    if (!wallet.value.wif || !wallet.value.address) {
      toast({
        title: t`Wallet Locked`,
        description: t`Unlock your wallet to publish a reveal transaction.`,
        status: "warning",
      });
      return;
    }

    setIsRevealing(true);
    try {
      const utxos = await db.txo
        .where({ contractType: ContractType.RXD, spent: 0 })
        .toArray();

      if (utxos.length === 0) {
        throw new Error("No RXD UTXOs available to fund the reveal transaction");
      }

      const cekBytes = hexToBytes(savedReveal.cek);
      const result = buildRevealTx(
        wallet.value.address,
        wallet.value.wif,
        {
          tokenRef,
          cek: cekBytes,
          cekHash: `sha256:${savedReveal.cekHash}`,
          ...(stub.crypto?.timelock?.hint
            ? { hint: stub.crypto.timelock.hint }
            : {}),
        },
        utxos,
        feeRate.value
      );

      const txid = await electrumWorker.value.broadcast(result.tx.toString());
      await db.broadcast.put({
        txid,
        date: Date.now(),
        description: "timelock_reveal",
      });

      // Reveal succeeded — drop the local CEK record (it's now on-chain)
      deleteReveal(tokenRef);
      setSavedReveal(undefined);

      toast({
        title: t`Reveal Published`,
        description: t`CEK is now on-chain — anyone can decrypt this content. Tx: ${txid.substring(0, 16)}…`,
        status: "success",
        duration: 9000,
      });
    } catch (error) {
      console.error("Reveal broadcast error:", error);
      toast({
        title: t`Reveal Failed`,
        description: error instanceof Error ? error.message : String(error),
        status: "error",
        duration: 8000,
      });
    } finally {
      setIsRevealing(false);
    }
  };

  return (
    <Box borderWidth={1} borderRadius="md" p={4} bg="bg.400">
      <VStack spacing={4} align="stretch">
        <HStack>
          <Icon as={MdLock} fontSize="2xl" color="blue.400" />
          <VStack align="start" spacing={0}>
            <Text fontWeight="bold">
              <Trans>Encrypted Content</Trans>
            </Text>
            <Text fontSize="sm" color="gray.400">
              {scheme.toUpperCase()}
            </Text>
          </VStack>
        </HStack>

        {isTimelocked && !timelockExpired && (
          <Alert status="warning" borderRadius="md">
            <AlertIcon as={MdTimer} />
            <AlertDescription>
              <VStack align="start" spacing={1}>
                <Text fontWeight="bold">
                  <Trans>Timelocked Content</Trans>
                </Text>
                <Text>
                  <Trans>
                    This content will unlock in {formatTimeRemaining(timeRemaining)}
                  </Trans>
                </Text>
              </VStack>
            </AlertDescription>
          </Alert>
        )}

        {isTimelocked && timelockExpired && (
          <Alert status="success" borderRadius="md">
            <AlertIcon as={MdLockOpen} />
            <AlertDescription>
              <Trans>Timelock has expired — content can now be decrypted</Trans>
            </AlertDescription>
          </Alert>
        )}

        {timelockExpired && (
          <Tabs variant="soft-rounded" colorScheme="blue" size="sm">
            <TabList>
              <Tab><Icon as={MdLockOpen} mr={1} /><Trans>Passphrase</Trans></Tab>
              <Tab isDisabled={!walletMnemonic || !isWalletKeyRecipient}>
                <Icon as={MdKey} mr={1} />
                <Trans>Wallet Key</Trans>
              </Tab>
            </TabList>

            <TabPanels>
              {/* ── Passphrase tab ── */}
              <TabPanel px={0}>
                <VStack spacing={3} align="stretch">
                  <FormControl>
                    <FormLabel>
                      <Trans>Decryption Password</Trans>
                    </FormLabel>
                    <Input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={t`Enter password`}
                      onKeyPress={(e) => e.key === "Enter" && handlePassphraseDecrypt()}
                    />
                  </FormControl>

                  {hint && (
                    <Text fontSize="sm" color="gray.400">
                      <Trans>Hint:</Trans> {hint}
                    </Text>
                  )}

                  {isDecrypting && decryptProgress && (
                    <EncryptionProgress
                      progress={decryptProgress}
                      operation="decrypting"
                    />
                  )}

                  <Button
                    colorScheme="blue"
                    onClick={handlePassphraseDecrypt}
                    isLoading={isDecrypting}
                    isDisabled={!password}
                    loadingText={t`Decrypting...`}
                    leftIcon={<Icon as={MdLockOpen} />}
                  >
                    <Trans>Decrypt with Password</Trans>
                  </Button>
                </VStack>
              </TabPanel>

              {/* ── Wallet key tab ── */}
              <TabPanel px={0}>
                <VStack spacing={3} align="stretch">
                  <Text fontSize="sm" color="gray.400">
                    <Trans>
                      Use your wallet's encryption key (HD path m/44'/0'/0'/2/0) to
                      decrypt content you were added as a recipient for.
                    </Trans>
                  </Text>
                  {!walletMnemonic && (
                    <Alert status="info" borderRadius="md">
                      <AlertIcon />
                      <AlertDescription fontSize="sm">
                        <Trans>Unlock your wallet to use your encryption key</Trans>
                      </AlertDescription>
                    </Alert>
                  )}
                  {walletMnemonic && !isWalletKeyRecipient && (
                    <Alert status="warning" borderRadius="md">
                      <AlertIcon />
                      <AlertDescription fontSize="sm">
                        <Trans>Your wallet key is not a recipient for this content</Trans>
                      </AlertDescription>
                    </Alert>
                  )}
                  {isDecrypting && decryptProgress && (
                    <EncryptionProgress
                      progress={decryptProgress}
                      operation="decrypting"
                    />
                  )}

                  <Button
                    colorScheme="blue"
                    onClick={handleWalletKeyDecrypt}
                    isLoading={isDecrypting}
                    isDisabled={!canUseWalletKey}
                    loadingText={t`Decrypting...`}
                    leftIcon={<Icon as={MdKey} />}
                  >
                    <Trans>Decrypt with Wallet Key</Trans>
                  </Button>
                </VStack>
              </TabPanel>
            </TabPanels>
          </Tabs>
        )}

        {/* ── Publish Reveal (owner-only, after timelock expires) ── */}
        {timelockExpired && savedReveal && tokenRef && !revealAlreadyBroadcast && (
          <>
            <Divider />
            <VStack spacing={3} align="stretch">
              <HStack>
                <Icon as={MdPublic} color="purple.400" fontSize="lg" />
                <Text fontWeight="bold" fontSize="sm">
                  <Trans>Publish Reveal (owner)</Trans>
                </Text>
              </HStack>
              <Text fontSize="xs" color="gray.400">
                <Trans>
                  You hold the saved CEK for this timelocked content. Publishing a
                  reveal transaction broadcasts the key on-chain so anyone can
                  decrypt it. This action is permanent.
                </Trans>
              </Text>
              <Button
                size="sm"
                colorScheme="purple"
                variant="outline"
                onClick={handlePublishReveal}
                isLoading={isRevealing}
                loadingText={t`Broadcasting…`}
                isDisabled={wallet.value.locked || !wallet.value.wif}
                leftIcon={<Icon as={MdPublic} />}
              >
                <Trans>Publish Reveal Transaction</Trans>
              </Button>
            </VStack>
          </>
        )}
      </VStack>
    </Box>
  );
}
