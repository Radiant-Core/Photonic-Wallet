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
  generateCommitment,
  createWaveCommitMetadata,
  verifyCommitment,
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
  
  // Commit-reveal state
  const [registrationPhase, setRegistrationPhase] = useState<"commit" | "reveal" | "complete">("commit");
  const [commitmentData, setCommitmentData] = useState<{
    commitment: string;
    salt: string;
    commitTxId?: string;
    revealAfterHeight: number;
  } | null>(null);
  
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

  const handleCommit = async () => {
    if (!wallet.value.wif || !utxos) {
      toast({
        title: "Error",
        description: "Wallet not unlocked or UTXOs not loaded",
        status: "error",
      });
      return;
    }

    setIsLoading(true);

    try {
      // Generate commitment for name (prevents front-running)
      const { commitment, salt } = generateCommitment(fullName);
      
      // Get current height for reveal timing
      const currentHeight = await electrumWorker.value.getBlockHeight();
      const revealAfterHeight = currentHeight + 1; // Minimum 1 block delay

      // Create commit metadata (temporary NFT holding the commitment)
      const commitMetadata = createWaveCommitMetadata(
        commitment,
        wallet.value.address,
        revealAfterHeight
      );

      // Mint commit NFT (no registration fee yet - paid on reveal)
      const { commitTx, revealTx } = mintToken(
        "nft",
        { method: "direct", params: { address: wallet.value.address }, value: 1 },
        wallet.value.wif,
        utxos,
        commitMetadata,
        [],
        feeRate.value,
        [] // No fee output for commit phase
      );

      // Broadcast commit transaction
      const commitTxId = await electrumWorker.value.broadcast(commitTx.toString());
      await db.broadcast.put({
        txid: commitTxId,
        date: Date.now(),
        description: "wave_name_commit",
      });

      // Store commitment data for reveal phase
      await db.kvp.put({
        key: `wave_commit_${commitTxId}`,
        value: {
          commitment,
          salt,
          fullName,
          target,
          description,
          customData,
          revealAfterHeight,
          commitTxId,
        },
      });

      setCommitmentData({
        commitment,
        salt,
        commitTxId,
        revealAfterHeight,
      });
      setRegistrationPhase("reveal");

      toast({
        title: "Commit Phase Complete",
        description: (
          <VStack align="start" spacing={1}>
            <Text>Commitment broadcast. Waiting for confirmation...</Text>
            <Text fontSize="sm">TXID: {commitTxId.slice(0, 20)}...</Text>
            <Text fontSize="sm">You can reveal after block {revealAfterHeight}</Text>
          </VStack>
        ),
        status: "success",
        duration: 10000,
      });
    } catch (error) {
      console.error("Commit failed:", error);
      toast({
        title: "Commit Failed",
        description: error instanceof Error ? error.message : "Unknown error occurred",
        status: "error",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleReveal = async () => {
    if (!wallet.value.wif || !utxos || !commitmentData) {
      toast({
        title: "Error",
        description: "Missing wallet data or commitment",
        status: "error",
      });
      return;
    }

    setIsLoading(true);

    try {
      // Retrieve stored commitment data
      const storedCommit = await db.kvp.get(`wave_commit_${commitmentData.commitTxId}`) as any;
      if (!storedCommit) {
        throw new Error("Commitment data not found");
      }

      // Verify commitment matches
      if (!verifyCommitment(commitmentData.commitment, fullName, commitmentData.salt)) {
        throw new Error("Commitment verification failed - name may have been tampered with");
      }

      // Check current height
      const currentHeight = await electrumWorker.value.getBlockHeight();
      if (currentHeight < storedCommit.revealAfterHeight) {
        throw new Error(`Cannot reveal yet. Wait until block ${storedCommit.revealAfterHeight} (current: ${currentHeight})`);
      }

      // Parse custom data
      let parsedData;
      if (storedCommit.customData) {
        parsedData = JSON.parse(storedCommit.customData);
      }

      // Create actual WAVE name metadata with 2-year default expiration
      const metadata = createWaveNameMetadata(fullName, wallet.value.address, {
        target: storedCommit.target,
        desc: storedCommit.description || `WAVE name: ${fullName}`,
        data: parsedData,
      });

      // Calculate registration fee
      const registrationFee = calculateNameCost(fullName);
      const feeAddress = "1GrwkQNJfjbEJjH25heszNZLpbZou8nfXG";
      const feeOutput = { script: p2pkhScript(feeAddress), value: registrationFee };

      // Record the commit txid in metadata (not the salt — keep salt off-chain)
      const metaAttrs = metadata.attrs as Record<string, unknown>;
      metaAttrs.commitTxId = commitmentData.commitTxId;

      // Mint WAVE name token with registration fee
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

      // Broadcast reveal transaction
      const revealTxId = await electrumWorker.value.broadcast(revealTx.toString());
      await db.broadcast.put({
        txid: revealTxId,
        date: Date.now(),
        description: "wave_name_reveal",
      });

      setRegistrationPhase("complete");

      toast({
        title: "WAVE Name Registered!",
        description: (
          <VStack align="start" spacing={1}>
            <Text>{fullName} is now yours for 2 years!</Text>
            <Text fontSize="sm">Reveal TX: {revealTxId.slice(0, 16)}...</Text>
            <Text fontSize="sm">Cost: {photonsToRXD(registrationFee)} RXD</Text>
          </VStack>
        ),
        status: "success",
        duration: 15000,
      });

      navigate("/wave-names");
    } catch (error) {
      console.error("Reveal failed:", error);
      toast({
        title: "Reveal Failed",
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

          {registrationPhase === "commit" && (
            <Button
              colorScheme="blue"
              size="lg"
              onClick={handleCommit}
              isLoading={isLoading}
              isDisabled={!validation.valid || isAvailable !== true || !target}
            >
              {"Commit Name"}
            </Button>
          )}

          {registrationPhase === "reveal" && commitmentData && (
            <VStack spacing={4} align="stretch">
              <Alert status="warning" borderRadius="md">
                <AlertIcon />
                <AlertDescription>
                  <VStack align="start" spacing={1}>
                    <Text fontWeight="bold">Ready to Reveal</Text>
                    <Text fontSize="sm">Commit confirmed. Click reveal to complete registration.</Text>
                    {commitmentData.revealAfterHeight > 0 && (
                      <Text fontSize="sm">Minimum block: {commitmentData.revealAfterHeight}</Text>
                    )}
                  </VStack>
                </AlertDescription>
              </Alert>
              <Button
                colorScheme="green"
                size="lg"
                onClick={handleReveal}
                isLoading={isLoading}
              >
                {"Reveal Name"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRegistrationPhase("commit");
                  setCommitmentData(null);
                }}
              >
                {"Cancel & Start Over"}
              </Button>
            </VStack>
          )}

          {registrationPhase === "complete" && (
            <Alert status="success" borderRadius="md">
              <AlertIcon />
              <AlertDescription>
                Registration complete! Redirecting to your WAVE names...
              </AlertDescription>
            </Alert>
          )}

          {/* Legacy button - should not be visible in new flow */}
          <Button
            colorScheme="blue"
            size="lg"
            display="none"
            onClick={handleCommit}
            isLoading={isLoading}
            isDisabled={!validation.valid || isAvailable !== true || !target}
            loadingText={"Registering..."}
          >
            Register WAVE Name
          </Button>
        </VStack>
      </ContentContainer>
    </Container>
  );
}
