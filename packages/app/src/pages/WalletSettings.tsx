import { useRef, useState } from "react";
import {
  Button,
  Center,
  Container,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  Heading,
  Input,
  Select,
  Text,
  useDisclosure,
  useToast,
  Code,
  HStack,
  VStack,
  Icon,
  useClipboard,
  Alert,
  AlertIcon,
  AlertDescription,
  Box,
  Collapse,
} from "@chakra-ui/react";
import {
  MdKey,
  MdContentCopy,
  MdCheck,
  MdQrCode,
  MdShare,
} from "react-icons/md";
import { QRCodeSVG } from "qrcode.react";
import { deriveEncryptionKeypair } from "@app/keys";
import { withWif } from "@app/wallet";
import { publicKeyHexFromWif } from "@lib/wallet";
import { bytesToHex } from "@noble/hashes/utils";
import PasswordModal from "@app/components/PasswordModal";
import RecoveryPhrase from "@app/components/RecoveryPhrase";
import { feeRate, language, wallet } from "@app/signals";
import FormSection from "@app/components/FormSection";
import DataRow from "@app/components/DataRow";
import db from "@app/db";
import { loadCatalog } from "@app/i18n";
import config from "@app/config.json";
import { useLiveQuery } from "dexie-react-hooks";
import { PromiseExtended } from "dexie";
import { electrumWorker } from "@app/electrum/Electrum";
import { discoverCovenants, syncCovenants } from "@app/covenant";
import {
  autoLockMs,
  clampAutoLockMs,
  DEFAULT_AUTO_LOCK_MS,
  MIN_AUTO_LOCK_MS,
  MAX_AUTO_LOCK_MS,
  saveAutoLockMs,
} from "@app/autoLock";

const MIN_FEE_RATE = 10000;

const normalizeFeeRate = (value: string | number) => {
  const parsed = typeof value === "number" ? value : parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return MIN_FEE_RATE;
  }
  return Math.max(MIN_FEE_RATE, parsed);
};

/** A copyable / QR-shareable public-key card. Renders an "unlock to view" hint
 *  when `value` is empty (the wallet is locked, so the key can't be derived). */
function PublicKeyField({
  heading,
  description,
  value,
  lockedHint,
  shareTitle,
}: {
  heading: string;
  description: string;
  value: string;
  lockedHint: string;
  shareTitle: string;
}) {
  const qr = useDisclosure();
  const { onCopy, hasCopied } = useClipboard(value);
  return (
    <FormSection>
      <Heading textStyle="h3">{heading}</Heading>
      <Text pt={2} textStyle="small">
        {description}
      </Text>
      {value ? (
        <VStack align="stretch" spacing={3} mt={3}>
          <Code
            p={2}
            borderRadius="md"
            fontSize="xs"
            fontFamily="mono"
            whiteSpace="pre-wrap"
            wordBreak="break-all"
            display="block"
            bg="surface.sunken"
          >
            {value}
          </Code>
          <HStack spacing={2}>
            <Button
              size="xs"
              variant="outline"
              leftIcon={<Icon as={hasCopied ? MdCheck : MdContentCopy} />}
              onClick={onCopy}
            >
              {hasCopied ? "Copied!" : "Copy"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              leftIcon={<Icon as={MdQrCode} />}
              onClick={qr.onToggle}
            >
              {qr.isOpen ? "Hide QR" : "Show QR"}
            </Button>
            {typeof navigator.share === "function" && (
              <Button
                size="xs"
                variant="outline"
                leftIcon={<Icon as={MdShare} />}
                onClick={() => navigator.share({ title: shareTitle, text: value })}
              >
                Share
              </Button>
            )}
          </HStack>
          <Collapse in={qr.isOpen} animateOpacity>
            <Box
              display="inline-flex"
              p={3}
              bg="white"
              borderRadius="md"
              borderWidth={1}
              borderColor="whiteAlpha.300"
            >
              <QRCodeSVG
                value={value}
                size={160}
                level="M"
                includeMargin={false}
              />
            </Box>
            <Text fontSize="xs" color="text.muted" mt={2}>
              Recipient can scan this to add your key without typing
            </Text>
          </Collapse>
        </VStack>
      ) : (
        <Alert status="info" mt={3} borderRadius="md" fontSize="sm">
          <AlertIcon as={MdKey} />
          <AlertDescription>{lockedHint}</AlertDescription>
        </Alert>
      )}
    </FormSection>
  );
}

export default function WalletSettings() {
  const disclosure = useDisclosure();
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [mnemonic, setMnemonic] = useState("");
  const passwordSuccess = (walletMnemonic: string) => {
    setMnemonic(walletMnemonic as string);
    setShowMnemonic(true);
    disclosure.onClose();
  };

  const encPubkeyHex = (() => {
    const m = wallet.value.mnemonic;
    if (!m) return "";
    try {
      // R26: derive on the same coin type the wallet spends from so the
      // public key shown here matches what a recipient-mode mint would
      // produce.
      const kp = deriveEncryptionKeypair(m.toString(), wallet.value.coinType);
      return bytesToHex(kp.x25519PublicKey);
    } catch {
      return "";
    }
  })();

  // Compressed secp256k1 spending pubkey — what a prediction-market oracle
  // committee (and any pubkey-based covenant) needs. Only derivable when
  // unlocked (the WIF is wiped on lock); empty string => "unlock to view".
  const signPubkeyHex = (() => {
    try {
      return withWif(publicKeyHexFromWif) ?? "";
    } catch {
      return "";
    }
  })();

  const languageRef = useRef<HTMLSelectElement>(null);
  const feeRateRef = useRef<HTMLInputElement>(null);
  const autoLockRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const [resyncing, setResyncing] = useState(false);

  // Resync: re-subscribe wallet scripthashes AND reconcile on-chain covenants
  // (royalty listings, soulbound, authority). The covenant reconcile is what
  // restores a royalty listing that an earlier build wrongly marked resolved —
  // manualSync() alone never touches covenant tracking, so a plain resync could
  // not bring such a listing back.
  const handleResync = async () => {
    setResyncing(true);
    try {
      await electrumWorker.value.manualSync();
      if (wallet.value.address) await discoverCovenants(wallet.value.address);
      if (wallet.value.swapAddress) {
        await discoverCovenants(wallet.value.swapAddress);
      }
      await syncCovenants();
      toast({ status: "success", title: "Resynced" });
    } catch (err) {
      toast({
        status: "error",
        title: "Resync failed",
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setResyncing(false);
    }
  };

  const keys = ["language", "feeRate"];
  const save = async () => {
    const newLanguage = languageRef.current?.value;
    const changeLang = language.value !== newLanguage;
    const feeRateNum = normalizeFeeRate(feeRateRef.current?.value || "");

    db.kvp.bulkPut([languageRef.current?.value, feeRateNum], keys);

    // R4: persist idle auto-lock duration (input is minutes; stored as ms).
    const lockMinutes = parseFloat(autoLockRef.current?.value || "");
    if (Number.isFinite(lockMinutes) && lockMinutes > 0) {
      await saveAutoLockMs(clampAutoLockMs(lockMinutes * 60 * 1000));
    }

    toast({
      title: "Saved",
      status: "success",
    });

    // Update fee rate signal
    feeRate.value = feeRateNum;

    if (changeLang && newLanguage) {
      // Change language
      await loadCatalog(newLanguage);
      // Trigger rerender on the currently rendered components
      language.value = newLanguage;
    }
  };
  const response = useLiveQuery(
    async () => await (db.kvp.bulkGet(keys) as PromiseExtended<string[]>),
    [],
    null
  );

  const consolidationRequired = useLiveQuery(() =>
    db.kvp.get("consolidationRequired")
  );

  if (response === null) return null;

  const [savedLanguage, savedFeeRate] = response;

  return (
    <Container maxW="container.md" px={4} display="grid" gap={8}>
      <FormSection>
        <Heading textStyle="h3">Address</Heading>
        <DataRow label="Main">
          <Text fontSize="sm" fontFamily="mono" wordBreak="break-all">
            {wallet.value.address}
          </Text>
        </DataRow>
        <DataRow label="Swap">
          <Text fontSize="sm" fontFamily="mono" wordBreak="break-all">
            {wallet.value.swapAddress}
          </Text>
        </DataRow>
      </FormSection>

      <PublicKeyField
        heading="Signing Public Key"
        description="Your compressed secp256k1 public key. Share it to be added to a prediction-market oracle committee, or for any pubkey-based covenant."
        value={signPubkeyHex}
        lockedHint="Unlock your wallet to view your signing public key."
        shareTitle="My Signing Public Key"
      />

      <PublicKeyField
        heading="Encryption Public Key"
        description="Share this key with anyone who wants to mint an encrypted NFT for you (recipient mode). It is safe to share — it cannot be used to decrypt your content."
        value={encPubkeyHex}
        lockedHint="Unlock your wallet to view your encryption public key."
        shareTitle="My Encryption Public Key"
      />

      <FormSection>
        <Heading textStyle="h3" mb={8}>
          Recovery phrase
        </Heading>
        {showMnemonic ? (
          <RecoveryPhrase phrase={mnemonic} />
        ) : (
          <Center mt={8} mb={16}>
            <Button onClick={() => disclosure.onOpen()}>
              Show recovery phrase
            </Button>
          </Center>
        )}
        <PasswordModal
          header="Enter password"
          allowClose
          onSuccess={passwordSuccess}
          isOpen={disclosure.isOpen}
          onClose={disclosure.onClose}
        />
      </FormSection>

      <FormSection>
        <Heading textStyle="h3">Manual Sync</Heading>
        {consolidationRequired === true &&
          "If your wallet fails to consolidate UTXOs, a resync may be required"}
        <Center mt={8} mb={16}>
          <Button onClick={handleResync} isLoading={resyncing}>
            Resync Wallet
          </Button>
        </Center>
      </FormSection>

      <FormSection>
        <FormControl>
          <FormLabel
            id="language-label"
            htmlFor="language-select"
            textStyle="label"
          >
            Language
          </FormLabel>
          <Select
            ref={languageRef}
            id="language-select"
            defaultValue={savedLanguage || ""}
            aria-labelledby="language-label"
            aria-label="Language"
            title="Language"
          >
            {Object.entries(config.i18n.languages).map(([k, v]) => (
              <option value={k} key={k}>
                {v}
              </option>
            ))}
          </Select>
        </FormControl>
        <FormControl>
          <FormLabel textStyle="label">Fee Rate</FormLabel>
          <Input
            ref={feeRateRef}
            type="number"
            min={MIN_FEE_RATE}
            step={1}
            placeholder={`${MIN_FEE_RATE}`}
            name="gateway"
            defaultValue={normalizeFeeRate(savedFeeRate || MIN_FEE_RATE)}
            sx={{ fontVariantNumeric: "tabular-nums" }}
          />
          <FormHelperText textStyle="small">
            {`Photons per byte (minimum ${MIN_FEE_RATE})`}
          </FormHelperText>
        </FormControl>
        <FormControl>
          <FormLabel textStyle="label">Auto-Lock (minutes)</FormLabel>
          <Input
            ref={autoLockRef}
            type="number"
            min={Math.ceil(MIN_AUTO_LOCK_MS / 60_000)}
            max={Math.floor(MAX_AUTO_LOCK_MS / 60_000)}
            step={1}
            placeholder={`${Math.round(DEFAULT_AUTO_LOCK_MS / 60_000)}`}
            defaultValue={Math.round(autoLockMs.value / 60_000)}
            sx={{ fontVariantNumeric: "tabular-nums" }}
          />
          <FormHelperText textStyle="small">
            {`Idle minutes before the wallet locks and secrets are wiped (default ${Math.round(
              DEFAULT_AUTO_LOCK_MS / 60_000
            )}).`}
          </FormHelperText>
        </FormControl>
      </FormSection>
      <Flex justifyContent="center" py={8} mb={16}>
        <Button
          variant="primary"
          size="lg"
          w="240px"
          maxW="100%"
          onClick={save}
        >
          Save
        </Button>
      </Flex>
    </Container>
  );
}
