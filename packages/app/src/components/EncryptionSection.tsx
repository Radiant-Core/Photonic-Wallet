/**
 * Encryption Section - Composite component for minting flow integration
 *
 * Combines EncryptToggle, EncryptionModeSelector, and progress display
 * into a single section that can be dropped into Mint.tsx.
 */

import { useState, useMemo } from "react";
import {
  VStack,
  HStack,
  FormControl,
  FormLabel,
  FormHelperText,
  Input,
  Button,
  Icon,
  Text,
  Alert,
  AlertIcon,
  AlertDescription,
  Spinner,
} from "@chakra-ui/react";
import { MdPersonAdd, MdClose } from "react-icons/md";
import { Trans, t } from "@lingui/macro";
import { EncryptToggle } from "./EncryptToggle";
import { EncryptionModeSelector } from "./EncryptionModeSelector";
import { EncryptionProgress } from "./EncryptionProgress";
import { StorageBackendSelector, type StorageBackend } from "./StorageBackendSelector";
import type {
  EncryptionMode,
  EncryptionProgress as ProgressType,
} from "../encryptionService";
import { estimateEncryptedSize, formatBytes } from "../encryptionService";
import db from "@app/db";
import { GLYPH_WAVE } from "@lib/protocols";

export type EncryptionSectionState = {
  enabled: boolean;
  mode: EncryptionMode;
  passphrase: string;
  recipientKeys: string[];
  storageBackend: StorageBackend;
};

export type EncryptionSectionProps = {
  /** Current encryption state */
  state: EncryptionSectionState;
  /** Callback when state changes */
  onChange: (state: EncryptionSectionState) => void;
  /** File size in bytes (for estimates) */
  fileSize?: number;
  /** Optional progress state during encryption */
  progress?: ProgressType | null;
  /** Whether encryption is in-flight */
  isEncrypting?: boolean;
  /** Error message */
  error?: string | null;
  /** Whether controls should be disabled */
  disabled?: boolean;
};

/**
 * Composite encryption section for mint flow
 */
export function EncryptionSection({
  state,
  onChange,
  fileSize,
  progress,
  isEncrypting = false,
  error,
  disabled = false,
}: EncryptionSectionProps) {
  const [newRecipient, setNewRecipient] = useState("");
  const [showAddRecipient, setShowAddRecipient] = useState(false);
  const [recipientKeyError, setRecipientKeyError] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);

  const isValidX25519HexKey = (key: string): boolean =>
    key.length === 64 && /^[0-9a-fA-F]+$/.test(key);

  /**
   * Resolve a WAVE name (e.g. "alice.rxd") or raw hex key.
   * Returns the X25519 hex public key on success, or null with an error set.
   */
  const resolveRecipientInput = async (input: string): Promise<string | null> => {
    const trimmed = input.trim();

    // Already a valid hex key — use it directly
    if (isValidX25519HexKey(trimmed)) {
      return trimmed;
    }

    // WAVE name: ends with .rxd or looks like name.domain
    if (trimmed.includes(".") || /^[a-z0-9-]{3,63}$/i.test(trimmed)) {
      setIsResolving(true);
      try {
        const glyphs = await db.glyph.toArray();
        const waveTokens = glyphs.filter(
          (g) => Array.isArray(g.p) && g.p.includes(GLYPH_WAVE)
        );

        const normalized = trimmed.toLowerCase().replace(/\.rxd$/, "");
        const match = waveTokens.find((g) => {
          const tokenName = (g.name || "").toLowerCase().replace(/\.rxd$/, "");
          return tokenName === normalized;
        });

        if (!match) {
          setRecipientKeyError(
            `WAVE name "${trimmed}" not found in local wallet. Ask the recipient to share their X25519 public key directly.`
          );
          return null;
        }

        const records = (match as any)?.attrs?.records as Record<string, string> | undefined;
        const x25519pub = records?.x25519_pub;

        if (!x25519pub) {
          setRecipientKeyError(
            `WAVE name "${trimmed}" found but has no x25519_pub encryption key in its records.`
          );
          return null;
        }

        if (!isValidX25519HexKey(x25519pub)) {
          setRecipientKeyError(
            `WAVE name "${trimmed}" has an invalid x25519_pub value (expected 64 hex chars).`
          );
          return null;
        }

        return x25519pub;
      } finally {
        setIsResolving(false);
      }
    }

    setRecipientKeyError(
      "Invalid input. Enter a 64-character hex X25519 public key or a WAVE name (e.g. alice.rxd)."
    );
    return null;
  };

  const estimate = useMemo(() => {
    if (!fileSize || !state.enabled) return null;
    const est = estimateEncryptedSize(fileSize);
    return {
      ...est,
      humanSize: formatBytes(est.encryptedSize),
    };
  }, [fileSize, state.enabled]);

  const handleToggle = (enabled: boolean) => {
    onChange({ ...state, enabled });
  };

  const handleModeChange = (mode: EncryptionMode) => {
    onChange({ ...state, mode });
  };

  const handlePassphraseChange = (passphrase: string) => {
    onChange({ ...state, passphrase });
  };

  const handleStorageBackendChange = (storageBackend: StorageBackend) => {
    onChange({ ...state, storageBackend });
  };

  const handleAddRecipient = async () => {
    const trimmed = newRecipient.trim();
    if (!trimmed) {
      setShowAddRecipient(true);
      return;
    }
    setRecipientKeyError(null);
    const resolvedKey = await resolveRecipientInput(trimmed);
    if (!resolvedKey) return;
    onChange({
      ...state,
      recipientKeys: [...state.recipientKeys, resolvedKey],
    });
    setNewRecipient("");
    setShowAddRecipient(false);
  };

  const handleRemoveRecipient = (index: number) => {
    onChange({
      ...state,
      recipientKeys: state.recipientKeys.filter((_, i) => i !== index),
    });
  };

  const isValid = state.enabled
    ? state.mode === "passphrase"
      ? state.passphrase.length >= 8
      : state.recipientKeys.length > 0
    : true;

  return (
    <VStack spacing={3} align="stretch" p={4} borderWidth={1} borderRadius="md" borderColor="whiteAlpha.200" bg="whiteAlpha.50">
      <EncryptToggle
        enabled={state.enabled}
        onChange={handleToggle}
        disabled={disabled || isEncrypting}
        estimatedSize={estimate?.humanSize}
        numChunks={estimate?.numChunks}
      />

      {state.enabled && (
        <VStack spacing={3} align="stretch">
          <StorageBackendSelector
            backend={state.storageBackend}
            onChange={handleStorageBackendChange}
            fileSize={fileSize}
            disabled={disabled || isEncrypting}
          />

          <EncryptionModeSelector
            mode={state.mode}
            onChange={handleModeChange}
            passphrase={state.passphrase}
            onPassphraseChange={handlePassphraseChange}
            recipientKeys={state.recipientKeys}
            onAddRecipient={() => setShowAddRecipient(true)}
            onRemoveRecipient={handleRemoveRecipient}
            disabled={disabled || isEncrypting}
          />

          {showAddRecipient && (
            <FormControl isInvalid={!!recipientKeyError}>
              <FormLabel fontSize="sm">
                <Trans>Recipient — WAVE name (e.g. alice.rxd) or X25519 public key</Trans>
              </FormLabel>
              <HStack>
                <Input
                  size="sm"
                  fontFamily="mono"
                  fontSize="xs"
                  value={newRecipient}
                  onChange={(e) => {
                    setNewRecipient(e.target.value);
                    setRecipientKeyError(null);
                  }}
                  placeholder={t`alice.rxd or a1b2c3d4… (64 hex)`}
                  isDisabled={disabled || isEncrypting || isResolving}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddRecipient();
                    }
                  }}
                  isInvalid={!!recipientKeyError}
                />
                <Button
                  size="sm"
                  colorScheme="blue"
                  onClick={handleAddRecipient}
                  isDisabled={disabled || isEncrypting || isResolving || !newRecipient.trim()}
                  leftIcon={isResolving ? <Spinner size="xs" /> : <Icon as={MdPersonAdd} />}
                  flexShrink={0}
                >
                  {isResolving ? <Trans>Resolving…</Trans> : <Trans>Add</Trans>}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowAddRecipient(false);
                    setNewRecipient("");
                    setRecipientKeyError(null);
                  }}
                  isDisabled={disabled || isEncrypting}
                  leftIcon={<Icon as={MdClose} />}
                  flexShrink={0}
                >
                  <Trans>Cancel</Trans>
                </Button>
              </HStack>
              {recipientKeyError && (
                <FormHelperText color="red.400" fontSize="xs">{recipientKeyError}</FormHelperText>
              )}
            </FormControl>
          )}

          {state.enabled && !isValid && (
            <Alert status="warning" borderRadius="md" fontSize="sm" py={2}>
              <AlertIcon />
              <AlertDescription>
                {state.mode === "passphrase"
                  ? <Trans>Passphrase must be at least 8 characters</Trans>
                  : <Trans>Add at least one recipient</Trans>}
              </AlertDescription>
            </Alert>
          )}

          {(progress || isEncrypting || error) && (
            <EncryptionProgress
              progress={progress ?? null}
              operation="encrypting"
              error={error}
            />
          )}
        </VStack>
      )}
    </VStack>
  );
}

/**
 * Initial state for EncryptionSection
 */
export const initialEncryptionState: EncryptionSectionState = {
  enabled: false,
  mode: "passphrase",
  passphrase: "",
  recipientKeys: [],
  storageBackend: "arweave",
};

/**
 * Check if encryption state is valid for submission
 */
export function isEncryptionStateValid(state: EncryptionSectionState): boolean {
  if (!state.enabled) return true;
  if (state.mode === "passphrase") {
    return state.passphrase.length >= 8;
  }
  return state.recipientKeys.length > 0;
}
