import React, { useState, useMemo, useEffect } from "react";
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
  Textarea,
  Code,
  Collapse,
  useDisclosure,
} from "@chakra-ui/react";
import { MdLock, MdLockOpen, MdTimer, MdKey, MdPublic, MdShare, MdContentCopy, MdCheck, MdOpenInNew } from "react-icons/md";
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
import { deriveKeyHKDF, unwrapCEK, wrapCEK } from "@lib/encryption";
import { buildShareUrl, parseShareInput, consumeShareFromUrl, type CekShareToken } from "@app/shareLink";
import { useClipboard } from "@chakra-ui/react";
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

  // ── CEK sharing: export ──────────────────────────────────────────────────
  const [recipientPubkeyHex, setRecipientPubkeyHex] = useState("");
  const [exportedShareUrl, setExportedShareUrl] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const { onCopy: onCopyExport, hasCopied: hasCopiedExport } = useClipboard(exportedShareUrl);
  const exportDisclosure = useDisclosure();

  // ── CEK sharing: import ──────────────────────────────────────────────────
  const [importInput, setImportInput] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const importDisclosure = useDisclosure();

  // Auto-read a pending share link from the URL fragment on mount
  useEffect(() => {
    const token = consumeShareFromUrl();
    if (!token) return;
    // Pre-fill the import field and open the panel
    setImportInput(buildShareUrl(token)); // store as URL so parseShareInput handles it
    importDisclosure.onOpen();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
      const cekHashAad = stub.crypto.cek_hash
        ? new TextEncoder().encode(stub.crypto.cek_hash)
        : undefined;
      for (const r of recipients) {
        const ephemeralBytes = new Uint8Array(Buffer.from(r.epk, "base64"));
        if (ephemeralBytes.every((b) => b === 0)) continue; // passphrase sentinel
        try {
          const ephemeral = {
            x25519EphemeralPublicKey: ephemeralBytes,
            ...(r.mlkem_ct
              ? { mlkemCiphertext: new Uint8Array(Buffer.from(r.mlkem_ct, "base64")) }
              : {}),
          };
          unwrapCEK(
            new Uint8Array(Buffer.from(r.wrapped_cek, "base64")),
            ephemeral,
            recipientKeyPair,
            cekHashAad
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
        title: "Storage Locator Missing",
        description: "Cannot retrieve encrypted blob — locator not found in token metadata",
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
      title: "Content Decrypted!",
      description: "Successfully unlocked encrypted content",
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
      title: "Content Decrypted!",
      description: "Successfully unlocked encrypted content",
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

  /**
   * Export: unwrap the minter's own CEK slot, then re-wrap it for the
   * target recipient's raw X25519 public key.
   * Output is a small JSON blob the recipient pastes into Import.
   */
  const handleExportCEK = async () => {
    if (!walletMnemonic) return;
    const recipientPubHex = recipientPubkeyHex.trim().replace(/^0x/i, "");
    if (recipientPubHex.length !== 64) {
      toast({
        title: "Invalid Public Key",
        description: "Recipient X25519 public key must be 32 bytes (64 hex chars)",
        status: "error",
        duration: 5000,
      });
      return;
    }
    setIsExporting(true);
    try {
      const keypair = deriveEncryptionKeypair(walletMnemonic);
      const recipients = stub.crypto?.recipients;
      if (!recipients?.length) throw new Error("No recipients in metadata");

      const cekHashAad = stub.crypto.cek_hash
        ? new TextEncoder().encode(stub.crypto.cek_hash)
        : undefined;

      // Unwrap our own slot to recover the raw CEK
      let cek: Uint8Array | undefined;
      for (const r of recipients) {
        const ephemeralBytes = new Uint8Array(Buffer.from(r.epk, "base64"));
        if (ephemeralBytes.every((b) => b === 0)) continue;
        try {
          const ephemeral = {
            x25519EphemeralPublicKey: ephemeralBytes,
            ...(r.mlkem_ct
              ? { mlkemCiphertext: new Uint8Array(Buffer.from(r.mlkem_ct, "base64")) }
              : {}),
          };
          cek = unwrapCEK(
            new Uint8Array(Buffer.from(r.wrapped_cek, "base64")),
            ephemeral,
            keypair,
            cekHashAad
          );
          break;
        } catch { /* try next */ }
      }
      if (!cek) throw new Error("Could not unwrap CEK — wallet not a recipient");

      // Re-wrap for the target recipient's X25519 public key, binding cek_hash as AAD
      const recipientPub = new Uint8Array(Buffer.from(recipientPubHex, "hex"));
      const { wrappedCEK, ephemeral: newEphemeral } = wrapCEK(
        cek,
        { x25519: recipientPub },
        cekHashAad
      );

      const tokenPayload: CekShareToken = {
        v: 1,
        ref: tokenRef ?? "",
        kid: "x25519",
        wrapped_cek: Buffer.from(wrappedCEK).toString("base64"),
        epk: Buffer.from(newEphemeral.x25519EphemeralPublicKey).toString("base64"),
        cek_hash: stub.crypto.cek_hash,
      };

      const shareUrl = buildShareUrl(tokenPayload);
      setExportedShareUrl(shareUrl);
      toast({
        title: "Access link ready",
        description: "Copy the link and send it to the recipient",
        status: "success",
        duration: 4000,
      });
    } catch (error) {
      toast({
        title: "Export Failed",
        description: error instanceof Error ? error.message : String(error),
        status: "error",
        duration: 6000,
      });
    } finally {
      setIsExporting(false);
    }
  };

  /**
   * Import: parse a share link or JSON blob, unwrap the CEK with the wallet's
   * private key, then run the normal decryptContent path.
   */
  const handleImportCEK = async () => {
    if (!assertStorageAvailable()) return;
    if (!walletMnemonic) {
      toast({
        title: "Wallet locked",
        description: "Unlock your wallet first, then try again",
        status: "warning",
      });
      return;
    }
    setIsImporting(true);
    setDecryptProgress(null);
    try {
      const token: CekShareToken | null = parseShareInput(importInput);
      if (!token) {
        throw new Error("Couldn't read the access link — paste the full link or token exactly as received");
      }

      // Verify cek_hash matches the on-chain commitment
      if (token.cek_hash && token.cek_hash !== stub.crypto.cek_hash) {
        throw new Error("cek_hash mismatch — this token is for a different NFT");
      }

      const keypair = deriveEncryptionKeypair(walletMnemonic);
      // cek_hash from the share token is the binding AAD used when it was wrapped
      const tokenCekHashAad = token.cek_hash
        ? new TextEncoder().encode(token.cek_hash)
        : undefined;
      const ephemeral = {
        x25519EphemeralPublicKey: new Uint8Array(Buffer.from(token.epk, "base64")),
      };
      const cek = unwrapCEK(
        new Uint8Array(Buffer.from(token.wrapped_cek, "base64")),
        ephemeral,
        keypair,
        tokenCekHashAad
      );

      // Re-wrap the recovered CEK for our own wallet key so decryptContent can use
      // the normal privateKey path.  Bind to stub's cek_hash as AAD.
      const myCekHashAad = stub.crypto.cek_hash
        ? new TextEncoder().encode(stub.crypto.cek_hash)
        : undefined;
      const { wrappedCEK: myWrappedCEK, ephemeral: myEphemeral } = wrapCEK(
        cek,
        { x25519: keypair.x25519PublicKey, mlkem: keypair.mlkemPublicKey },
        myCekHashAad
      );

      const isHybrid = !!myEphemeral.mlkemCiphertext;
      const patchedRecipient = {
        kid: isHybrid ? "x25519mlkem768" : "x25519",
        alg: (isHybrid
          ? "x25519mlkem768-hkdf-xchacha20poly1305"
          : "x25519-hkdf-xchacha20poly1305") as
          "x25519-hkdf-xchacha20poly1305" | "x25519mlkem768-hkdf-xchacha20poly1305",
        wrapped_cek: Buffer.from(myWrappedCEK).toString("base64"),
        epk: Buffer.from(myEphemeral.x25519EphemeralPublicKey).toString("base64"),
        ...(myEphemeral.mlkemCiphertext
          ? { mlkem_ct: Buffer.from(myEphemeral.mlkemCiphertext).toString("base64") }
          : {}),
      };

      // Build a patched stub with our slot prepended
      const patchedStub = {
        ...stub,
        crypto: {
          ...stub.crypto,
          recipients: [patchedRecipient, ...(stub.crypto.recipients ?? [])],
        },
      };

      const locatorKey = isOnChain
        ? undefined
        : deriveKeyHKDF(
            keypair.x25519PrivateKey,
            new Uint8Array(0),
            new TextEncoder().encode("glyph-locator-recipient-v1"),
            32
          );

      if (isOnChain) {
        const encryptedBlob = hexToBytes(mainB!);
        const plaintext = await decryptContent(
          encryptedBlob,
          { metadata: patchedStub, privateKey: keypair },
          (p) => setDecryptProgress({ stage: p.stage as ProgressType["stage"], loaded: p.loaded, total: p.total, percent: p.percent })
        );
        toast({ title: "Content Decrypted!", status: "success" });
        onDecrypted(plaintext);
      } else {
        await fetchAndDecryptOffChain(locatorKey!, {
          metadata: patchedStub,
          privateKey: keypair,
        });
      }

      setImportInput("");
    } catch (error) {
      console.error("CEK import error:", error);
      toast({
        title: "Import Failed",
        description: error instanceof Error ? error.message : String(error),
        status: "error",
        duration: 7000,
      });
    } finally {
      setIsImporting(false);
    }
  };

  /** Passphrase mode: user types password */
  const handlePassphraseDecrypt = async () => {
    if (!password) {
      toast({
        title: "Password Required",
        description: "Please enter the decryption password",
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
        title: "Decryption Failed",
        description: "Invalid password or corrupted content",
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
        title: "Wallet Locked",
        description: "Unlock your wallet first to use your encryption key",
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
        privateKey: keypair,
      });
    } catch (error) {
      console.error("Wallet key decryption error:", error);
      toast({
        title: "Decryption Failed",
        description: "Your wallet key is not a recipient for this content",
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
        title: "No Reveal Available",
        description: "No saved CEK was found for this token.",
        status: "warning",
      });
      return;
    }
    if (!wallet.value.wif || !wallet.value.address) {
      toast({
        title: "Wallet Locked",
        description: "Unlock your wallet to publish a reveal transaction.",
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
        title: "Reveal Published",
        description: `CEK is now on-chain — anyone can decrypt this content. Tx: ${txid.substring(0, 16)}…`,
        status: "success",
        duration: 9000,
      });
    } catch (error) {
      console.error("Reveal broadcast error:", error);
      toast({
        title: "Reveal Failed",
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
              Encrypted Content
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
                  Timelocked Content
                </Text>
                <Text>
                    This content will unlock in {formatTimeRemaining(timeRemaining)}
                </Text>
              </VStack>
            </AlertDescription>
          </Alert>
        )}

        {isTimelocked && timelockExpired && (
          <Alert status="success" borderRadius="md">
            <AlertIcon as={MdLockOpen} />
            <AlertDescription>
              Timelock has expired — content can now be decrypted
            </AlertDescription>
          </Alert>
        )}

        {timelockExpired && (
          <Tabs variant="soft-rounded" colorScheme="blue" size="sm">
            <TabList>
              <Tab><Icon as={MdLockOpen} mr={1} />Passphrase</Tab>
              <Tab isDisabled={!walletMnemonic || !isWalletKeyRecipient}>
                <Icon as={MdKey} mr={1} />
                Wallet Key
              </Tab>
            </TabList>

            <TabPanels>
              {/* ── Passphrase tab ── */}
              <TabPanel px={0}>
                <VStack spacing={3} align="stretch">
                  <FormControl>
                    <FormLabel>
                      Decryption Password
                    </FormLabel>
                    <Input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter password"
                      onKeyPress={(e) => e.key === "Enter" && handlePassphraseDecrypt()}
                    />
                  </FormControl>

                  {hint && (
                    <Text fontSize="sm" color="gray.400">
                      Hint: {hint}
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
                    loadingText="Decrypting..."
                    leftIcon={<Icon as={MdLockOpen} />}
                  >
                    Decrypt with Password
                  </Button>
                </VStack>
              </TabPanel>

              {/* ── Wallet key tab ── */}
              <TabPanel px={0}>
                <VStack spacing={3} align="stretch">
                  <Text fontSize="sm" color="gray.400">
                    Decrypt content that was shared directly with your wallet.
                  </Text>
                  {!walletMnemonic && (
                    <Alert status="info" borderRadius="md">
                      <AlertIcon />
                      <AlertDescription fontSize="sm">
                        Unlock your wallet to use your encryption key
                      </AlertDescription>
                    </Alert>
                  )}
                  {walletMnemonic && !isWalletKeyRecipient && (
                    <Alert status="warning" borderRadius="md">
                      <AlertIcon />
                      <AlertDescription fontSize="sm">
                        Your wallet key is not a recipient for this content
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
                    loadingText="Decrypting..."
                    leftIcon={<Icon as={MdKey} />}
                  >
                    Decrypt with Wallet Key
                  </Button>
                </VStack>
              </TabPanel>
            </TabPanels>
          </Tabs>
        )}

        {/* ── CEK Import (any wallet-unlocked viewer who received a share link) ── */}
        {timelockExpired && !!walletMnemonic && !isWalletKeyRecipient && (
          <>
            <Divider />
            <VStack spacing={3} align="stretch">
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<Icon as={MdOpenInNew} />}
                onClick={importDisclosure.onToggle}
                justifyContent="flex-start"
              >
                Use an access link
              </Button>
              <Collapse in={importDisclosure.isOpen}>
                <VStack spacing={3} align="stretch" pt={1}>
                  <Text fontSize="xs" color="gray.400">
                    Paste the access link sent to you by the content owner. Your wallet will automatically unlock and decrypt the content.
                  </Text>
                  <FormControl>
                    <FormLabel fontSize="sm">Access link or token</FormLabel>
                    <Textarea
                      size="sm"
                      rows={3}
                      value={importInput}
                      onChange={(e) => setImportInput(e.target.value)}
                      placeholder="Paste the link you received here…"
                    />
                  </FormControl>
                  {isImporting && decryptProgress && (
                    <EncryptionProgress progress={decryptProgress} operation="decrypting" />
                  )}
                  <Button
                    size="sm"
                    colorScheme="blue"
                    onClick={handleImportCEK}
                    isLoading={isImporting}
                    isDisabled={!importInput.trim()}
                    loadingText="Unlocking…"
                    leftIcon={<Icon as={MdLockOpen} />}
                  >
                    Unlock with access link
                  </Button>
                </VStack>
              </Collapse>
            </VStack>
          </>
        )}

        {/* ── CEK Export (wallet-key recipients can share access to other wallets) ── */}
        {timelockExpired && isWalletKeyRecipient && (
          <>
            <Divider />
            <VStack spacing={3} align="stretch">
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<Icon as={MdShare} />}
                onClick={exportDisclosure.onToggle}
                justifyContent="flex-start"
              >
                Give someone access
              </Button>
              <Collapse in={exportDisclosure.isOpen}>
                <VStack spacing={3} align="stretch" pt={1}>
                  <Text fontSize="xs" color="gray.400">
                    Enter the recipient’s encryption public key to generate a one-time access link. Only they can use it — find the key in their wallet under Settings → Encryption Public Key.
                  </Text>
                  <FormControl>
                    <FormLabel fontSize="sm">Recipient’s encryption public key</FormLabel>
                    <Input
                      size="sm"
                      fontFamily="mono"
                      fontSize="xs"
                      value={recipientPubkeyHex}
                      onChange={(e) => setRecipientPubkeyHex(e.target.value)}
                      placeholder="64-character key from their wallet Settings"
                    />
                  </FormControl>
                  <Button
                    size="sm"
                    colorScheme="teal"
                    onClick={handleExportCEK}
                    isLoading={isExporting}
                    isDisabled={!walletMnemonic || recipientPubkeyHex.trim().replace(/^0x/i, "").length !== 64}
                    loadingText="Creating link…"
                    leftIcon={<Icon as={MdShare} />}
                  >
                    Create access link
                  </Button>
                  {exportedShareUrl && (
                    <VStack spacing={2} align="stretch">
                      <Text fontSize="xs" color="gray.400">
                        Send this link to the recipient — it works only with their wallet key:
                      </Text>
                      <Code
                        fontSize="xs"
                        p={2}
                        borderRadius="md"
                        whiteSpace="pre-wrap"
                        wordBreak="break-all"
                        display="block"
                        bg="bg.200"
                      >
                        {exportedShareUrl}
                      </Code>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={onCopyExport}
                        leftIcon={<Icon as={hasCopiedExport ? MdCheck : MdContentCopy} />}
                      >
                        {hasCopiedExport ? "Copied!" : "Copy link"}
                      </Button>
                    </VStack>
                  )}
                </VStack>
              </Collapse>
            </VStack>
          </>
        )}

        {/* ── Publish Reveal (owner-only, after timelock expires) ── */}
        {timelockExpired && savedReveal && tokenRef && !revealAlreadyBroadcast && (
          <>
            <Divider />
            <VStack spacing={3} align="stretch">
              <HStack>
                <Icon as={MdPublic} color="purple.400" fontSize="lg" />
                <Text fontWeight="bold" fontSize="sm">
                  Publish Reveal (owner)
                </Text>
              </HStack>
              <Text fontSize="xs" color="gray.400">
                  You hold the saved CEK for this timelocked content. Publishing a reveal transaction broadcasts the key on-chain so anyone can decrypt it. This action is permanent.
              </Text>
              <Button
                size="sm"
                colorScheme="purple"
                variant="outline"
                onClick={handlePublishReveal}
                isLoading={isRevealing}
                loadingText="Broadcasting…"
                isDisabled={wallet.value.locked || !wallet.value.wif}
                leftIcon={<Icon as={MdPublic} />}
              >
                Publish Reveal Transaction
              </Button>
            </VStack>
          </>
        )}
      </VStack>
    </Box>
  );
}
