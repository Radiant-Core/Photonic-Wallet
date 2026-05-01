import React, { useState } from "react";
import {
  VStack,
  HStack,
  FormControl,
  FormLabel,
  FormHelperText,
  Switch,
  NumberInput,
  NumberInputField,
  NumberInputStepper,
  NumberIncrementStepper,
  NumberDecrementStepper,
  Input,
  Button,
  IconButton,
  Text,
  Divider,
} from "@chakra-ui/react";
import { AddIcon, DeleteIcon } from "@chakra-ui/icons";
import { Trans, t } from "@lingui/macro";
import { GlyphV2Royalty } from "@lib/v2metadata";

type RoyaltyConfigProps = {
  value?: GlyphV2Royalty;
  onChange: (royalty: GlyphV2Royalty | undefined) => void;
};

export default function RoyaltyConfig({ value, onChange }: RoyaltyConfigProps) {
  const [enabled, setEnabled] = useState(!!value);
  const [enforced, setEnforced] = useState(value?.enforced ?? false);
  const [bps, setBps] = useState(value?.bps ?? 500); // Default 5%
  const [address, setAddress] = useState(value?.address ?? "");
  const [minimum, setMinimum] = useState(value?.minimum ?? 0);
  const [splits, setSplits] = useState<Array<{ address: string; bps: number }>>(
    value?.splits ?? []
  );

  const handleUpdate = () => {
    if (!enabled) {
      onChange(undefined);
      return;
    }

    const royalty: GlyphV2Royalty = {
      enforced,
      bps,
      address,
    };

    if (minimum > 0) {
      royalty.minimum = minimum;
    }

    if (splits.length > 0) {
      royalty.splits = splits;
    }

    onChange(royalty);
  };

  const addSplit = () => {
    setSplits([...splits, { address: "", bps: 0 }]);
  };

  const removeSplit = (index: number) => {
    setSplits(splits.filter((_, i) => i !== index));
  };

  const updateSplit = (index: number, field: "address" | "bps", value: string | number) => {
    const newSplits = [...splits];
    if (field === "address") {
      newSplits[index].address = value as string;
    } else {
      newSplits[index].bps = value as number;
    }
    setSplits(newSplits);
  };

  React.useEffect(() => {
    handleUpdate();
  }, [enabled, enforced, bps, address, minimum, splits]);

  const totalSplitBps = splits.reduce((sum, s) => sum + s.bps, 0);
  const splitError = splits.length > 0 && totalSplitBps !== bps;

  return (
    <VStack spacing={4} align="stretch">
      <FormControl display="flex" alignItems="center">
        <FormLabel mb={0}>
          Enable Royalties
        </FormLabel>
        <Switch
          isChecked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
      </FormControl>

      {enabled && (
        <>
          <FormControl display="flex" alignItems="center">
            <FormLabel mb={0}>
              Enforce On-Chain
            </FormLabel>
            <Switch
              isChecked={enforced}
              onChange={(e) => setEnforced(e.target.checked)}
            />
            <FormHelperText ml={3} mb={0}>
              {enforced
                ? "Royalties enforced by smart contract"
                : "Advisory only"}
            </FormHelperText>
          </FormControl>

          <FormControl>
            <FormLabel>
              Royalty Percentage
            </FormLabel>
            <NumberInput
              value={bps / 100}
              onChange={(_, value) => setBps(value * 100)}
              min={0}
              max={100}
              step={0.1}
              precision={2}
            >
              <NumberInputField />
              <NumberInputStepper>
                <NumberIncrementStepper />
                <NumberDecrementStepper />
              </NumberInputStepper>
            </NumberInput>
            <FormHelperText>
              {bps} basis points ({bps / 100}%)
            </FormHelperText>
          </FormControl>

          <FormControl>
            <FormLabel>
              Royalty Recipient Address
            </FormLabel>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={"Enter Radiant address"}
            />
          </FormControl>

          <FormControl>
            <FormLabel>
              Minimum Royalty (photons)
            </FormLabel>
            <NumberInput
              value={minimum}
              onChange={(_, value) => setMinimum(value)}
              min={0}
            >
              <NumberInputField />
              <NumberInputStepper>
                <NumberIncrementStepper />
                <NumberDecrementStepper />
              </NumberInputStepper>
            </NumberInput>
            <FormHelperText>
              Optional minimum royalty amount
            </FormHelperText>
          </FormControl>

          <Divider />

          <VStack align="stretch" spacing={3}>
            <HStack justify="space-between">
              <Text fontWeight="bold">
                Royalty Splits (Optional)
              </Text>
              <Button
                size="sm"
                leftIcon={<AddIcon />}
                onClick={addSplit}
                variant="outline"
              >
                Add Split
              </Button>
            </HStack>

            {splits.map((split, index) => (
              <HStack key={index} spacing={2}>
                <Input
                  placeholder={"Address"}
                  value={split.address}
                  onChange={(e) => updateSplit(index, "address", e.target.value)}
                  flex={2}
                />
                <NumberInput
                  value={split.bps / 100}
                  onChange={(_, value) => updateSplit(index, "bps", value * 100)}
                  min={0}
                  max={100}
                  step={0.1}
                  precision={2}
                  flex={1}
                >
                  <NumberInputField placeholder="%" />
                </NumberInput>
                <IconButton
                  aria-label={"Remove split"}
                  icon={<DeleteIcon />}
                  onClick={() => removeSplit(index)}
                  colorScheme="red"
                  variant="ghost"
                />
              </HStack>
            ))}

            {splitError && (
              <Text color="red.400" fontSize="sm">
                Split percentages must sum to {bps / 100}% (currently{" "}
                {totalSplitBps / 100}%)
              </Text>
            )}
          </VStack>
        </>
      )}
    </VStack>
  );
}
