import React, { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Button,
  Center,
  Checkbox,
  Container,
  FormControl,
  FormHelperText,
  FormLabel,
  Heading,
  Input,
  Select,
  Textarea,
  useBreakpointValue,
} from "@chakra-ui/react";
import {
  recoverKeys,
  LEGACY_COIN_TYPE,
  validatePasswordStrength,
  MIN_PASSWORD_LENGTH,
} from "@app/keys";
import Card from "@app/components/Card";
import { NetworkKey } from "@lib/types";
import config from "@app/config.json";
import { initWallet } from "@app/wallet";

const networkKeys = Object.entries(config.networks)
  .filter(([, v]) => v.enabled)
  .map(([k]) => k);

export default function RecoverWallet() {
  const phrase = useRef<HTMLTextAreaElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const confirm = useRef<HTMLInputElement>(null);
  const network = useRef<HTMLSelectElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [forceLegacy, setForceLegacy] = useState(false);
  // Live password-policy feedback shown under the new-password field.
  const [passwordHint, setPasswordHint] = useState("");
  const navigate = useNavigate();
  const isMobile = useBreakpointValue({ base: true, lg: false });

  const onPasswordChange = (value: string) => {
    if (!value) {
      setPasswordHint("");
      return;
    }
    const result = validatePasswordStrength(value);
    setPasswordHint(result.ok ? "Password strength: OK" : result.reason);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const passwordValue = password.current?.value || "";
    const confirmValue = confirm.current?.value || "";
    const strength = validatePasswordStrength(passwordValue);
    if (!strength.ok) {
      setError(strength.reason);
      return false;
    }
    if (confirmValue !== passwordValue) {
      setError("Passwords do not match");
      return false;
    }

    if (!networkKeys.includes(network.current?.value || "")) {
      setError("Select a valid network");
      return false;
    }

    setLoading(true);

    // setTimeout allows loading spinner to render without a delay
    setTimeout(async () => {
      setError("");
      try {
        const result = await recoverKeys(
          network.current?.value as NetworkKey,
          phrase.current?.value || "",
          passwordValue,
          // Explicit override forces the legacy (coin type 0) path used by
          // Photonic Wallet pre-v3.0.0. When unchecked, recoverKeys probes
          // ElectrumX to auto-detect which path holds on-chain history.
          forceLegacy ? LEGACY_COIN_TYPE : undefined
        );
        if (!result) {
          return;
        }
        const { address, wif, net, coinType } = result;
        initWallet({ net, wif, address, coinType });
        navigate(isMobile ? "/home" : "/objects");
      } catch (error) {
        console.log(error);
        if (error instanceof Error) {
          if (error.message === "Invalid mnemonic") {
            setError("Invalid recovery phrase");
          } else {
            setError(error.message);
          }
        } else {
          setError("Unknown error");
        }
      }
      setLoading(false);
    }, 1);
    return false;
  };

  return (
    <Container
      display="flex"
      alignItems="center"
      mt="72px"
      py={2}
      height={{ lg: "calc(100vh - 72px)" }}
    >
      <Card mb={4} p={4} width="2xl">
        <Heading size="md" mb={4}>
          {"Recover your wallet"}
        </Heading>
        {error && (
          <Alert status="error" mb={4}>
            <AlertIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form onSubmit={submit}>
          <FormControl mb={4}>
            <FormLabel>{"Enter your 12 word recovery phrase"}</FormLabel>
            <Textarea
              ref={phrase}
              placeholder={"Recovery phrase"}
              size="sm"
              resize="none"
              autoFocus
            />
          </FormControl>
          <FormControl mb={4}>
            <FormLabel>{"New password"}</FormLabel>
            <Input
              ref={password}
              type="password"
              placeholder="Password"
              onChange={(e) => onPasswordChange(e.target.value)}
            />
            <FormHelperText
              color={
                passwordHint === "Password strength: OK"
                  ? "green.400"
                  : passwordHint
                  ? "red.400"
                  : undefined
              }
            >
              {passwordHint ||
                `Use at least ${MIN_PASSWORD_LENGTH} characters with a mix of letters, numbers, or symbols.`}
            </FormHelperText>
          </FormControl>
          <FormControl mb={4}>
            <FormLabel>{"Confirm password"}</FormLabel>
            <Input ref={confirm} type="password" placeholder="Password" />
          </FormControl>
          <FormControl mb={4}>
            <FormLabel>{"Network"}</FormLabel>
            <Select ref={network}>
              {networkKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </FormControl>
          <FormControl mb={4}>
            <Checkbox
              isChecked={forceLegacy}
              onChange={(e) => setForceLegacy(e.target.checked)}
            >
              {"Use legacy derivation path (m/44'/0'/...)"}
            </Checkbox>
            <FormHelperText>
              {
                "Leave unchecked to auto-detect. Tick this only if recovery shows an empty wallet and you know your seed was created in Photonic Wallet before v3.0.0."
              }
            </FormHelperText>
          </FormControl>
          <Button
            width="full"
            type="submit"
            isLoading={loading}
            loadingText={"Recovering"}
          >
            {"Submit"}
          </Button>
          <Center mt={4}>
            <Button variant="ghost" as={Link} to="/create-wallet">
              {"Create a new wallet"}
            </Button>
          </Center>
        </form>
      </Card>
    </Container>
  );
}
