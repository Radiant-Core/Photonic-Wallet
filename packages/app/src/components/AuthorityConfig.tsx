import React, { useEffect, useState } from "react";
import {
  VStack,
  Box,
  FormControl,
  FormLabel,
  FormHelperText,
  Switch,
  Input,
  Alert,
  AlertIcon,
  AlertDescription,
} from "@chakra-ui/react";

/**
 * The authority-token attributes recorded in an NFT's metadata `attrs` (the
 * issuer address is filled in by the mint flow). When this value is `undefined`
 * the NFT is an ordinary token; when set, the mint adds the GLYPH_AUTHORITY
 * protocol so the token can later gate mints via "Authority gating".
 */
export type AuthorityTokenConfig = {
  scope?: string;
  permissions?: string[];
  expires?: string; // ISO8601
  revocable?: boolean;
};

type AuthorityConfigProps = {
  value?: AuthorityTokenConfig;
  onChange: (value: AuthorityTokenConfig | undefined) => void;
};

/**
 * Configure whether the NFT being minted is an issuer **Authority token**.
 *
 * An authority token is just a normal NFT tagged with the GLYPH_AUTHORITY
 * protocol — minting it needs no special permission. Its power comes later:
 * other items can be minted requiring this token to be co-spent
 * (OP_REQUIREINPUTREF), so only its holder can issue them.
 */
export default function AuthorityConfig({
  value,
  onChange,
}: AuthorityConfigProps) {
  const [enabled, setEnabled] = useState(!!value);
  const [scope, setScope] = useState(value?.scope ?? "");
  const [permissions, setPermissions] = useState(
    (value?.permissions ?? []).join(", ")
  );
  // <input type="date"> wants YYYY-MM-DD; metadata stores full ISO8601.
  const [expires, setExpires] = useState(
    value?.expires ? value.expires.slice(0, 10) : ""
  );
  const [revocable, setRevocable] = useState(value?.revocable ?? true);

  useEffect(() => {
    if (!enabled) {
      onChange(undefined);
      return;
    }
    const perms = permissions
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    let iso: string | undefined;
    if (expires) {
      const d = new Date(expires);
      if (!isNaN(d.getTime())) iso = d.toISOString();
    }
    onChange({
      scope: scope.trim() || undefined,
      permissions: perms.length ? perms : undefined,
      expires: iso,
      revocable,
    });
  }, [enabled, scope, permissions, expires, revocable]);

  return (
    <VStack spacing={4} align="stretch">
      <FormControl display="flex" alignItems="center">
        <FormLabel mb={0} flex={1}>
          Make this an Authority token
        </FormLabel>
        <Switch
          isChecked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
      </FormControl>

      {enabled && (
        <>
          <Alert status="info" borderRadius="md" fontSize="sm">
            <AlertIcon />
            <AlertDescription>
              Tags this NFT with the Authority protocol. Keep it safe — whoever
              holds it can mint items gated on its reference. Select it later
              under “Authority gating” when minting those items.
              <Box as="strong" display="block" mt={2}>
                {
                  "Soulbound authority can't be co-spent to gate mints — mint non-soulbound if you want to use it for authority gating."
                }
              </Box>
            </AlertDescription>
          </Alert>

          <FormControl>
            <FormLabel>Scope (optional)</FormLabel>
            <Input
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder="e.g. my-collection"
            />
            <FormHelperText>What this authority governs.</FormHelperText>
          </FormControl>

          <FormControl>
            <FormLabel>Permissions (optional)</FormLabel>
            <Input
              value={permissions}
              onChange={(e) => setPermissions(e.target.value)}
              placeholder="mint, revoke"
            />
            <FormHelperText>
              Comma-separated list recorded in metadata.
            </FormHelperText>
          </FormControl>

          <FormControl>
            <FormLabel>Expires (optional)</FormLabel>
            <Input
              type="date"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
            <FormHelperText>
              After this date the authority is treated as expired and can no
              longer issue (verifyAuthorityChain rejects it).
            </FormHelperText>
          </FormControl>

          <FormControl display="flex" alignItems="center">
            <FormLabel mb={0} flex={1}>
              Revocable
            </FormLabel>
            <Switch
              isChecked={revocable}
              onChange={(e) => setRevocable(e.target.checked)}
            />
          </FormControl>
        </>
      )}
    </VStack>
  );
}
