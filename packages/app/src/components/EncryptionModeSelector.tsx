/**
 * Encryption Mode Selector Component
 *
 * Allows choosing between passphrase-based or recipient-based encryption.
 */

import { useState } from "react";
import {
  VStack,
  HStack,
  Button,
  ButtonGroup,
  FormControl,
  FormLabel,
  FormHelperText,
  Input,
  InputGroup,
  InputRightElement,
  IconButton,
  Tag,
  TagLabel,
  TagCloseButton,
  Text,
  Progress,
  Box,
  Icon,
} from "@chakra-ui/react";
import { MdVisibility, MdVisibilityOff, MdPersonAdd, MdLock, MdPeople } from "react-icons/md";
import { Trans, t } from "@lingui/macro";
import type { EncryptionMode } from "../encryptionService";

export type EncryptionModeSelectorProps = {
  /** Current encryption mode */
  mode: EncryptionMode;
  /** Callback when mode changes */
  onChange: (mode: EncryptionMode) => void;
  /** Passphrase value */
  passphrase?: string;
  /** Callback when passphrase changes */
  onPassphraseChange?: (passphrase: string) => void;
  /** Recipient public keys */
  recipientKeys?: string[];
  /** Callback to add recipient */
  onAddRecipient?: () => void;
  /** Callback to remove recipient */
  onRemoveRecipient?: (index: number) => void;
  /** Whether disabled */
  disabled?: boolean;
};

function evaluateStrength(pass: string): number {
  let score = 0;
  if (pass.length >= 8) score += 20;
  if (pass.length >= 12) score += 20;
  if (/[A-Z]/.test(pass)) score += 15;
  if (/[a-z]/.test(pass)) score += 15;
  if (/[0-9]/.test(pass)) score += 15;
  if (/[^A-Za-z0-9]/.test(pass)) score += 15;
  return Math.min(score, 100);
}

function strengthMeta(score: number): { label: string; color: string } {
  if (score < 40) return { label: t`Weak`, color: "red" };
  if (score < 70) return { label: t`Medium`, color: "yellow" };
  return { label: t`Strong`, color: "green" };
}

/**
 * Mode selector for encryption type (passphrase vs recipient)
 */
export function EncryptionModeSelector({
  mode,
  onChange,
  passphrase,
  onPassphraseChange,
  recipientKeys,
  onAddRecipient,
  onRemoveRecipient,
  disabled = false,
}: EncryptionModeSelectorProps) {
  const [showPassword, setShowPassword] = useState(false);
  const strength = evaluateStrength(passphrase || "");
  const { label: strengthLabel, color: strengthColor } = strengthMeta(strength);

  return (
    <VStack spacing={3} align="stretch">
      {/* Mode toggle */}
      <ButtonGroup size="sm" isAttached variant="outline" isDisabled={disabled}>
        <Button
          leftIcon={<Icon as={MdLock} />}
          onClick={() => onChange("passphrase")}
          variant={mode === "passphrase" ? "solid" : "outline"}
          colorScheme={mode === "passphrase" ? "blue" : undefined}
          flex={1}
        >
          <Trans>Passphrase</Trans>
        </Button>
        <Button
          leftIcon={<Icon as={MdPeople} />}
          onClick={() => onChange("recipient")}
          variant={mode === "recipient" ? "solid" : "outline"}
          colorScheme={mode === "recipient" ? "blue" : undefined}
          flex={1}
        >
          <Trans>Recipients</Trans>
        </Button>
      </ButtonGroup>

      {mode === "passphrase" && (
        <VStack spacing={2} align="stretch">
          <FormControl isRequired>
            <FormLabel fontSize="sm"><Trans>Encryption Passphrase</Trans></FormLabel>
            <InputGroup size="sm">
              <Input
                type={showPassword ? "text" : "password"}
                value={passphrase || ""}
                onChange={(e) => onPassphraseChange?.(e.target.value)}
                placeholder={t`Enter a strong passphrase…`}
                isDisabled={disabled}
                pr="2.5rem"
              />
              <InputRightElement>
                <IconButton
                  aria-label={showPassword ? t`Hide passphrase` : t`Show passphrase`}
                  icon={<Icon as={showPassword ? MdVisibilityOff : MdVisibility} />}
                  size="xs"
                  variant="ghost"
                  onClick={() => setShowPassword((v) => !v)}
                  isDisabled={disabled}
                  tabIndex={-1}
                />
              </InputRightElement>
            </InputGroup>
          </FormControl>

          {passphrase && passphrase.length > 0 && (
            <Box>
              <Progress
                value={strength}
                size="xs"
                colorScheme={strengthColor}
                borderRadius="full"
              />
              <Text fontSize="xs" color={`${strengthColor}.300`} mt={1}>
                {strengthLabel}
              </Text>
            </Box>
          )}

          <FormHelperText fontSize="xs">
            <Trans>Required to decrypt content. Store it securely — it cannot be recovered.</Trans>
          </FormHelperText>
        </VStack>
      )}

      {mode === "recipient" && (
        <VStack spacing={2} align="stretch">
          <FormLabel fontSize="sm" mb={0}><Trans>Recipients</Trans></FormLabel>

          {recipientKeys && recipientKeys.length > 0 && (
            <HStack flexWrap="wrap" gap={2}>
              {recipientKeys.map((key, index) => (
                <Tag key={index} size="sm" colorScheme="blue" borderRadius="full">
                  <TagLabel fontFamily="mono" fontSize="xs">
                    {key.slice(0, 8)}…{key.slice(-6)}
                  </TagLabel>
                  <TagCloseButton
                    isDisabled={disabled}
                    onClick={() => onRemoveRecipient?.(index)}
                  />
                </Tag>
              ))}
            </HStack>
          )}

          <Button
            size="sm"
            variant="outline"
            leftIcon={<Icon as={MdPersonAdd} />}
            onClick={onAddRecipient}
            isDisabled={disabled}
            alignSelf="flex-start"
          >
            <Trans>Add Recipient</Trans>
          </Button>

          <FormHelperText fontSize="xs">
            <Trans>Add by WAVE name (e.g. alice.rxd) or X25519 public key. Only listed recipients can decrypt.</Trans>
          </FormHelperText>
        </VStack>
      )}
    </VStack>
  );
}
