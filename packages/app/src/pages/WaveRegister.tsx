import React, { useState, useEffect } from "react";
import {
  Container,
  VStack,
  HStack,
  FormControl,
  FormLabel,
  FormHelperText,
  Input,
  Button,
  Text,
  Alert,
  AlertIcon,
  AlertDescription,
  Box,
  Divider,
  useToast,
  Spinner,
} from "@chakra-ui/react";
import { useLiveQuery } from "dexie-react-hooks";
import PageHeader from "@app/components/PageHeader";
import ContentContainer from "@app/components/ContentContainer";
import { wallet, feeRate } from "@app/signals";
import { mintToken } from "@lib/mint";
import { 
  createWaveNameMetadata, 
  validateWaveName, 
  calculateNameCost,
} from "@lib/wave";
import { photonsToRXD } from "@lib/format";
import { p2pkhScript } from "@lib/script";
import { electrumWorker } from "@app/electrum/Electrum";
import db from "@app/db";
import { ContractType } from "@app/types";
import { useNavigate } from "react-router-dom";

export default function WaveRegister() {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [description, setDescription] = useState("");
  const [customData, setCustomData] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [serverCanVerify, setServerCanVerify] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  
  const [registrationPhase, setRegistrationPhase] = useState<"idle" | "broadcasting" | "complete">("idle");
  
  const toast = useToast();
  const navigate = useNavigate();

  const utxos = useLiveQuery(
    () => db.txo.where({ contractType: ContractType.RXD, spent: 0 }).toArray(),
    []
  );

  const fullName = name ? `${name}.rxd` : "";
  const validation = validateWaveName(fullName);
  const cost = fullName ? calculateNameCost(fullName) : 0;

  useEffect(() => {
    const checkAvailability = async () => {
      if (!fullName || !validation.valid) {
        setIsAvailable(null);
        return;
      }

      setIsChecking(true);
      setServerCanVerify(null);
      try {
        // Query RXinDexer for name availability
        const available = await electrumWorker.value.checkWaveAvailable(fullName);
        setIsAvailable(available);
        setServerCanVerify(true);
      } catch (error) {
        // If the server doesn't support wave.check_available, fall back to assuming available
        // The actual registration will fail on-chain if name is taken
        console.warn("WAVE availability check failed:", error);
        setIsAvailable(true);
        setServerCanVerify(false);
      } finally {
        setIsChecking(false);
      }
    };

    const debounce = setTimeout(checkAvailability, 500);
    return () => clearTimeout(debounce);
  }, [fullName, validation.valid]);

  const handleRegister = async () => {
    if (!wallet.value.wif || !utxos) {
      toast({
        title: "Error",
        description: "Wallet not unlocked or UTXOs not loaded",
        status: "error",
      });
      return;
    }

    setIsLoading(true);
    setRegistrationPhase("broadcasting");

    try {
      // Parse custom data
      let parsedData;
      if (customData) {
        parsedData = JSON.parse(customData);
      }

      // Create WAVE name metadata with 2-year default expiration
      const metadata = createWaveNameMetadata(fullName, wallet.value.address, {
        target,
        desc: description || `WAVE name: ${fullName}`,
        data: parsedData,
      });

      // Registration fee output
      const registrationFee = calculateNameCost(fullName);
      const feeAddress = "1GrwkQNJfjbEJjH25heszNZLpbZou8nfXG";
      const feeOutput = { script: p2pkhScript(feeAddress), value: registrationFee };

      // mintToken does its own internal commit+reveal — broadcast both
      const { commitTx, revealTx } = mintToken(
        "nft",
        { method: "direct", params: { address: wallet.value.address }, value: 1 },
        wallet.value.wif,
        utxos,
        metadata,
        [],
        feeRate.value,
        [feeOutput]
      );

      const commitTxId = await electrumWorker.value.broadcast(commitTx.toString());
      const revealTxId = await electrumWorker.value.broadcast(revealTx.toString());

      await db.broadcast.put({ txid: commitTxId, date: Date.now(), description: "wave_name_commit" });
      await db.broadcast.put({ txid: revealTxId, date: Date.now(), description: "wave_name_reveal" });

      setRegistrationPhase("complete");

      toast({
        title: "WAVE Name Registered!",
        description: (
          <VStack align="start" spacing={1}>
            <Text>{fullName} is now yours for 2 years!</Text>
            <Text fontSize="sm">TX: {revealTxId.slice(0, 16)}...</Text>
            <Text fontSize="sm">Cost: {photonsToRXD(registrationFee)} RXD</Text>
          </VStack>
        ),
        status: "success",
        duration: 15000,
      });

      navigate("/wave-names");
    } catch (error) {
      console.error("Registration failed:", error);
      setRegistrationPhase("idle");
      toast({
        title: "Registration Failed",
        description: error instanceof Error ? error.message : "Unknown error occurred",
        status: "error",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Container maxW="container.md" py={8}>
      <PageHeader>
        {"Register WAVE Name"}
      </PageHeader>

      <ContentContainer>
        <VStack spacing={6} align="stretch">
          <FormControl isInvalid={!!name && !validation.valid}>
            <FormLabel>
              WAVE Name
            </FormLabel>
            <HStack>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                placeholder={"alice"}
                flex={1}
              />
              <Text fontWeight="bold">.rxd</Text>
            </HStack>
            <FormHelperText>
              {!name && "Enter a name (3-63 characters, lowercase alphanumeric and hyphens)"}
              {name && !validation.valid && <Text color="red.400">{validation.error}</Text>}
              {name && validation.valid && isChecking && (
                <HStack>
                  <Spinner size="xs" />
                  Checking availability...
                </HStack>
              )}
              {name && validation.valid && !isChecking && isAvailable === true && serverCanVerify === true && (
                <Text color="green.400">
                  ✓ Available
                </Text>
              )}
              {name && validation.valid && !isChecking && isAvailable === true && serverCanVerify === false && (
                <Alert status="warning" size="sm" borderRadius="md" py={1}>
                  <AlertIcon boxSize={4} />
                  <AlertDescription fontSize="sm">
                    Server cannot verify availability. Registration will fail if name is already taken.
                  </AlertDescription>
                </Alert>
              )}
              {name && validation.valid && !isChecking && isAvailable === false && (
                <Text color="red.400">
                  ✗ Name already registered
                </Text>
              )}
            </FormHelperText>
          </FormControl>

          {validation.valid && (
            <Alert status="info" borderRadius="md">
              <AlertIcon />
              <AlertDescription>
                <VStack align="start" spacing={1}>
                  <Text fontWeight="bold">
                    Registration Cost
                  </Text>
                  <Text fontSize="lg" color="blue.300">
                    {photonsToRXD(cost)} RXD
                  </Text>
                  <Text fontSize="sm">
                    Shorter names cost more. This is a one-time fee.
                  </Text>
                </VStack>
              </AlertDescription>
            </Alert>
          )}

          <Divider />

          <FormControl>
            <FormLabel>
              Target Address/Reference
            </FormLabel>
            <Input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"}
            />
            <FormHelperText>
              The address or token reference this name points to
            </FormHelperText>
          </FormControl>

          <FormControl>
            <FormLabel>
              Description (Optional)
            </FormLabel>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={"My primary Radiant address"}
            />
          </FormControl>

          <Alert status="info" borderRadius="md" variant="subtle">
            <AlertIcon />
            <AlertDescription>
              <VStack align="start" spacing={1}>
                <Text fontWeight="bold">Registration Info</Text>
                <Text fontSize="sm">All WAVE names now have a default 2-year expiration with a 30-day grace period for renewal.</Text>
                <Text fontSize="sm">Registration uses commit-reveal pattern to prevent front-running and ensure fair allocation.</Text>
              </VStack>
            </AlertDescription>
          </Alert>

          <FormControl>
            <FormLabel>
              Custom Data (Optional JSON)
            </FormLabel>
            <Input
              value={customData}
              onChange={(e) => setCustomData(e.target.value)}
              placeholder={'{"twitter": "@alice", "website": "alice.com"}'}
              fontFamily="mono"
            />
            <FormHelperText>
              Additional metadata in JSON format
            </FormHelperText>
          </FormControl>

          {registrationPhase === "complete" ? (
            <Alert status="success" borderRadius="md">
              <AlertIcon />
              <AlertDescription>
                Registration complete! Redirecting to your WAVE names...
              </AlertDescription>
            </Alert>
          ) : (
            <Button
              colorScheme="brand"
              size="lg"
              onClick={handleRegister}
              isLoading={isLoading || registrationPhase === "broadcasting"}
              isDisabled={!validation.valid || isAvailable !== true || !target}
              loadingText={"Registering..."}
            >
              {"Register WAVE Name"}
            </Button>
          )}
        </VStack>
      </ContentContainer>
    </Container>
  );
}
