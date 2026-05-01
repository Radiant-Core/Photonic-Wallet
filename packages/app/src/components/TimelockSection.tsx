/**
 * Timelock Section — UI for locking encrypted content until a block height or time.
 * Phase 5 (REP-3009): Drop this into Mint.tsx after EncryptionSection.
 *
 * Security note: Timelock is only available when encryption is enabled.
 * The CEK backup (self-as-recipient) is automatically enforced before the
 * timelock commitment is created, preventing permanent content loss.
 */

import { useState } from "react";
import { t } from "@lingui/macro";
import {
  Box,
  Button,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  HStack,
  Input,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  Text,
} from "@chakra-ui/react";
import {
  resolveTimelockParams,
  validateTimelockState,
  initialTimelockState,
  type TimelockSectionState,
} from "../timelockHelpers";
import { type TimelockMode } from "@lib/timelock";

export type {
  TimelockSectionState,
} from "../timelockHelpers";
export {
  resolveTimelockParams,
  validateTimelockState,
  initialTimelockState,
} from "../timelockHelpers";

export type TimelockSectionProps = {
  /** Current timelock state */
  state: TimelockSectionState;
  /** Callback when state changes */
  onChange: (state: TimelockSectionState) => void;
  /** Whether the parent encryption section is enabled (timelock requires encryption) */
  encryptionEnabled: boolean;
  /** Current best-block height for block-mode validation (optional) */
  currentBlock?: number;
  /** Whether disabled (e.g. during minting) */
  disabled?: boolean;
};

// ============================================================================
// Component
// ============================================================================

/**
 * TimelockSection
 *
 * Renders a toggle + configuration panel for locking encrypted content
 * until a specific block height or point in time.
 *
 * Only usable when encryption is enabled (enforced by UI and submit()).
 */
export function TimelockSection({
  state,
  onChange,
  encryptionEnabled,
  currentBlock,
  disabled = false,
}: TimelockSectionProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const update = (patch: Partial<TimelockSectionState>) =>
    onChange({ ...state, ...patch });

  const validationError =
    state.enabled ? validateTimelockState(state, currentBlock) : null;

  // Minimum datetime-local value = now + 5 minutes
  const minDatetime = new Date(Date.now() + 5 * 60 * 1000)
    .toISOString()
    .slice(0, 16);

  const isDisabled = disabled || !encryptionEnabled;

  return (
    <Box
      borderWidth="1px"
      borderRadius="md"
      borderColor={
        state.enabled && encryptionEnabled ? "purple.400" : "whiteAlpha.200"
      }
      bg={state.enabled && encryptionEnabled ? "purple.900" : "whiteAlpha.50"}
      p={4}
      mt={2}
    >
      {/* Header toggle */}
      <Flex align="center" justify="space-between">
        <Box>
          <Text fontWeight="semibold" fontSize="sm">
            {"Timelock"}
          </Text>
          <Text fontSize="xs" color="gray.400">
            {encryptionEnabled
              ? "Lock content until a block height or date"
              : "Enable encryption first to use timelock"}
          </Text>
        </Box>
        <Switch
          isChecked={state.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
          isDisabled={isDisabled}
          colorScheme="purple"
          size="md"
        />
      </Flex>

      {/* Configuration panel */}
      {state.enabled && encryptionEnabled && (
        <Stack spacing={3} mt={4}>
          {/* Mode selector */}
          <FormControl>
            <FormLabel fontSize="xs" color="gray.300" mb={1}>
              {"Lock until"}
            </FormLabel>
            <RadioGroup
              value={state.mode}
              onChange={(v) =>
                update({ mode: v as TimelockMode, unlockValue: "" })
              }
              isDisabled={disabled}
            >
              <HStack spacing={4}>
                <Radio value="time" colorScheme="purple" size="sm">
                  <Text fontSize="sm">{"Date / Time"}</Text>
                </Radio>
                <Radio value="block" colorScheme="purple" size="sm">
                  <Text fontSize="sm">{"Block Height"}</Text>
                </Radio>
              </HStack>
            </RadioGroup>
          </FormControl>

          {/* Unlock value input */}
          <FormControl isInvalid={!!validationError}>
            {state.mode === "time" ? (
              <>
                <Input
                  type="datetime-local"
                  value={state.unlockValue}
                  min={minDatetime}
                  onChange={(e) => update({ unlockValue: e.target.value })}
                  isDisabled={disabled}
                  size="sm"
                  bg="whiteAlpha.100"
                />
                <FormHelperText fontSize="xs" color="gray.400">
                  {"Content will be inaccessible until this date."}
                </FormHelperText>
              </>
            ) : (
              <>
                <Input
                  type="number"
                  placeholder={
                    currentBlock
                      ? "Current block: ${currentBlock}"
                      : "Enter block height"
                  }
                  value={state.unlockValue}
                  onChange={(e) => update({ unlockValue: e.target.value })}
                  isDisabled={disabled}
                  min={currentBlock ? currentBlock + 1 : 1}
                  size="sm"
                  bg="whiteAlpha.100"
                />
                {currentBlock !== undefined && state.unlockValue && (
                  <FormHelperText fontSize="xs" color="gray.400">
                    {(() => {
                      const blocksLeft =
                        parseInt(state.unlockValue, 10) - currentBlock;
                      if (isNaN(blocksLeft) || blocksLeft <= 0) return null;
                      const mins = blocksLeft * 2;
                      return "~${mins} min (~${blocksLeft} blocks)";
                    })()}
                  </FormHelperText>
                )}
              </>
            )}
            {validationError && (
              <Text fontSize="xs" color="red.400" mt={1}>
                {validationError}
              </Text>
            )}
          </FormControl>

          {/* Hint (optional) */}
          <Button
            size="xs"
            variant="ghost"
            colorScheme="gray"
            onClick={() => setShowAdvanced((v) => !v)}
            alignSelf="flex-start"
            isDisabled={disabled}
          >
            {showAdvanced ? "Hide hint" : "Add hint (optional)"}
          </Button>

          {showAdvanced && (
            <FormControl>
              <FormLabel fontSize="xs" color="gray.300" mb={1}>
                {"Hint for viewers"}
              </FormLabel>
              <Input
                placeholder={"e.g. \"Reveal on New Year's Day\""}
                value={state.hint}
                onChange={(e) => update({ hint: e.target.value })}
                isDisabled={disabled}
                size="sm"
                maxLength={120}
                bg="whiteAlpha.100"
              />
              <FormHelperText fontSize="xs" color="gray.400">
                {"Shown publicly before unlock. Do not include sensitive info."}
              </FormHelperText>
            </FormControl>
          )}

          {/* Security warning */}
          <Box
            bg="orange.900"
            borderColor="orange.600"
            borderWidth="1px"
            borderRadius="sm"
            p={2}
          >
            <Text fontSize="xs" color="orange.200">
              ⚠️{" "}
              {"Your wallet's backup key is always added as a recipient. Keep your wallet seed phrase safe — it's the only way to recover timelocked content if the reveal is lost."}
            </Text>
          </Box>
        </Stack>
      )}
    </Box>
  );
}
