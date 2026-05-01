import React from "react";
import {
  VStack,
  FormControl,
  FormLabel,
  FormHelperText,
  Switch,
  Alert,
  AlertIcon,
  AlertDescription,
} from "@chakra-ui/react";
import { Trans } from "@lingui/macro";
import { GlyphV2Policy } from "@lib/v2metadata";

type PolicyConfigProps = {
  value?: GlyphV2Policy;
  onChange: (policy: GlyphV2Policy) => void;
};

export default function PolicyConfig({ value, onChange }: PolicyConfigProps) {
  const policy = value ?? {
    renderable: true,
    executable: false,
    nsfw: false,
    transferable: true,
  };

  const updatePolicy = (field: keyof GlyphV2Policy, newValue: boolean) => {
    onChange({ ...policy, [field]: newValue });
  };

  return (
    <VStack spacing={4} align="stretch">
      <FormControl display="flex" alignItems="center">
        <FormLabel mb={0} flex={1}>
          Renderable
        </FormLabel>
        <Switch
          isChecked={policy.renderable ?? true}
          onChange={(e) => updatePolicy("renderable", e.target.checked)}
        />
      </FormControl>
      <FormHelperText mt={-2}>
        Safe to display in wallets and explorers
      </FormHelperText>

      <FormControl display="flex" alignItems="center">
        <FormLabel mb={0} flex={1}>
          Executable
        </FormLabel>
        <Switch
          isChecked={policy.executable ?? false}
          onChange={(e) => updatePolicy("executable", e.target.checked)}
        />
      </FormControl>
      <FormHelperText mt={-2}>
        Contains executable code (use with caution)
      </FormHelperText>

      <FormControl display="flex" alignItems="center">
        <FormLabel mb={0} flex={1}>
          NSFW Content
        </FormLabel>
        <Switch
          isChecked={policy.nsfw ?? false}
          onChange={(e) => updatePolicy("nsfw", e.target.checked)}
        />
      </FormControl>
      <FormHelperText mt={-2}>
        Adult or sensitive content flag
      </FormHelperText>

      <FormControl display="flex" alignItems="center">
        <FormLabel mb={0} flex={1}>
          Transferable
        </FormLabel>
        <Switch
          isChecked={policy.transferable ?? true}
          onChange={(e) => updatePolicy("transferable", e.target.checked)}
        />
      </FormControl>
      <FormHelperText mt={-2}>
        {policy.transferable
          ? "Token can be transferred normally"
          : "Soulbound - cannot be transferred"}
      </FormHelperText>

      {!policy.transferable && (
        <Alert status="warning" borderRadius="md">
          <AlertIcon />
          <AlertDescription>
            Soulbound tokens are permanently bound to the original owner and
            can only be burned. This cannot be changed after minting.
          </AlertDescription>
        </Alert>
      )}
    </VStack>
  );
}
