import { useState, useEffect, useCallback } from "react";
import { t } from "@lingui/macro";
import {
  Box,
  Button,
  FormControl,
  FormLabel,
  Heading,
  HStack,
  Icon,
  IconButton,
  Input,
  Select,
  SimpleGrid,
  Switch,
  Table,
  Tag,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  useToast,
  VStack,
} from "@chakra-ui/react";
import { TbLock, TbLockOpen, TbPlus, TbTrash } from "react-icons/tb";
import PageHeader from "@app/components/PageHeader";
import ContentContainer from "@app/components/ContentContainer";
import Photons from "@app/components/Photons";
import { wallet, feeRate, openModal } from "@app/signals";
import { electrumWorker } from "@app/electrum/Electrum";
import db from "@app/db";
import { ContractType, VaultRecord } from "@app/types";
import { useLiveQuery } from "dexie-react-hooks";
import {
  buildVaultTx,
  buildVestingTx,
  p2shOutputScript,
  isVaultUnlockable,
  formatLocktime,
  vaultTimeRemaining,
  claimVaultTx,
  VAULT_MAX_LOCKTIME_BLOCKS,
  VAULT_MAX_TRANCHES,
  type VaultParams,
  type VaultAssetType,
  type VaultMode,
  type VestingTranche,
} from "@lib/vault";

type Tranche = {
  locktime: string;
  value: string;
};

export default function VaultPage() {
  const toast = useToast();

  // ────────────────────────────────────────────────────────
  // Tab state
  // ────────────────────────────────────────────────────────
  const [tab, setTab] = useState<"create" | "list">("list");

  // ────────────────────────────────────────────────────────
  // Create form state
  // ────────────────────────────────────────────────────────
  const [assetType, setAssetType] = useState<VaultAssetType>("rxd");
  const [mode, setMode] = useState<VaultMode>("block");
  const [recipient, setRecipient] = useState("");
  const [locktime, setLocktime] = useState("");
  const [amount, setAmount] = useState("");
  const [label, setLabel] = useState("");
  const [ref, setRef] = useState("");
  const [vesting, setVesting] = useState(false);
  const [tranches, setTranches] = useState<Tranche[]>([
    { locktime: "", value: "" },
  ]);
  const [loading, setLoading] = useState(false);

  // ────────────────────────────────────────────────────────
  // Vault list from DB (live query)
  // ────────────────────────────────────────────────────────
  const vaults = useLiveQuery(
    () => db.vault.orderBy("date").reverse().toArray(),
    []
  );

  // ────────────────────────────────────────────────────────
  // Current blockchain height (approximated from header)
  // ────────────────────────────────────────────────────────
  const [currentHeight, setCurrentHeight] = useState(0);
  useEffect(() => {
    db.header
      .orderBy("height")
      .reverse()
      .first()
      .then((h) => {
        if (h?.height) setCurrentHeight(h.height);
      });
  }, [vaults]);

  const currentTimestamp = Math.floor(Date.now() / 1000);

  // ────────────────────────────────────────────────────────
  // Self-fill recipient
  // ────────────────────────────────────────────────────────
  const fillSelf = useCallback(() => {
    setRecipient(wallet.value.address);
  }, []);

  // ────────────────────────────────────────────────────────
  // Tranche helpers
  // ────────────────────────────────────────────────────────
  const addTranche = () => {
    if (tranches.length < VAULT_MAX_TRANCHES) {
      setTranches([...tranches, { locktime: "", value: "" }]);
    }
  };

  const removeTranche = (index: number) => {
    if (tranches.length > 1) {
      setTranches(tranches.filter((_, i) => i !== index));
    }
  };

  const updateTranche = (
    index: number,
    field: keyof Tranche,
    val: string
  ) => {
    const updated = [...tranches];
    updated[index] = { ...updated[index], [field]: val };
    setTranches(updated);
  };

  // ────────────────────────────────────────────────────────
  // Create vault
  // ────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (wallet.value.locked || !wallet.value.wif) {
      openModal.value = { modal: "unlock" };
      return;
    }

    setLoading(true);
    try {
      const wif = wallet.value.wif;
      const fromAddress = wallet.value.address;

      // Fetch RXD UTXOs for funding
      const coins = await db.txo
        .where({ contractType: ContractType.RXD, spent: 0 })
        .toArray();

      const coinInputs = coins.map((c) => ({
        txid: c.txid,
        vout: c.vout,
        script: c.script,
        value: c.value,
      }));

      if (!vesting) {
        // Simple vault
        const lt = parseInt(locktime, 10);
        const val = Math.round(parseFloat(amount) * 1e8);
        if (!lt || !val || !recipient) {
          throw new Error("Fill in all fields");
        }

        const params: VaultParams = {
          mode,
          locktime: lt,
          assetType,
          recipientAddress: recipient,
          ref: assetType !== "rxd" ? ref : undefined,
          value: val,
          label: label || undefined,
        };

        const result = buildVaultTx(
          coinInputs,
          fromAddress,
          wif,
          params,
          feeRate.value
        );

        // Broadcast
        const txid = await electrumWorker.value.broadcast(result.rawTx);

        // Store vault record
        const record: VaultRecord = {
          txid,
          vout: 0,
          value: val,
          assetType,
          mode,
          locktime: lt,
          recipientAddress: recipient,
          senderAddress: fromAddress,
          ref: assetType !== "rxd" ? ref : undefined,
          label: label || undefined,
          redeemScriptHex: result.redeemScriptHex,
          p2shScriptHex: p2shOutputScript(result.redeemScriptHex),
          claimed: 0,
          date: Date.now(),
        };
        await db.vault.put(record);
        await db.broadcast.put({ txid, date: Date.now(), description: "vault_create" });

        toast({
          title: t`Vault Created`,
          description: `${txid.slice(0, 8)}…`,
          status: "success",
        });

        // Reset form
        setLocktime("");
        setAmount("");
        setLabel("");
        setRef("");
        setTab("list");
      } else {
        // Vesting schedule
        const vestingTranches: VestingTranche[] = tranches.map((tr) => ({
          mode,
          locktime: parseInt(tr.locktime, 10),
          assetType,
          recipientAddress: recipient,
          ref: assetType !== "rxd" ? ref : undefined,
          value: Math.round(parseFloat(tr.value) * 1e8),
          label: label || undefined,
        }));

        const result = buildVestingTx(
          coinInputs,
          fromAddress,
          wif,
          vestingTranches,
          feeRate.value
        );

        const txid = await electrumWorker.value.broadcast(result.rawTx);

        // Store vault records for each tranche
        for (let i = 0; i < vestingTranches.length; i++) {
          const record: VaultRecord = {
            txid,
            vout: i,
            value: vestingTranches[i].value,
            assetType,
            mode,
            locktime: vestingTranches[i].locktime,
            recipientAddress: recipient,
            senderAddress: fromAddress,
            ref: assetType !== "rxd" ? ref : undefined,
            label: label ? `${label} (${i + 1}/${vestingTranches.length})` : undefined,
            redeemScriptHex: result.redeemScripts[i],
            p2shScriptHex: p2shOutputScript(result.redeemScripts[i]),
            claimed: 0,
            date: Date.now(),
          };
          await db.vault.put(record);
        }
        await db.broadcast.put({ txid, date: Date.now(), description: "vault_vesting" });

        toast({
          title: t`Vesting Schedule Created`,
          description: `${vestingTranches.length} tranches`,
          status: "success",
        });

        setTranches([{ locktime: "", value: "" }]);
        setLabel("");
        setRef("");
        setTab("list");
      }
    } catch (err: unknown) {
      toast({
        title: t`Error`,
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  // ────────────────────────────────────────────────────────
  // Claim vault
  // ────────────────────────────────────────────────────────
  const handleClaim = async (vault: VaultRecord) => {
    if (wallet.value.locked || !wallet.value.wif) {
      openModal.value = { modal: "unlock" };
      return;
    }

    try {
      const wif = wallet.value.wif;
      const toAddress = wallet.value.address;

      const result = claimVaultTx(
        {
          txid: vault.txid,
          vout: vault.vout,
          value: vault.value,
          redeemScriptHex: vault.redeemScriptHex,
        },
        toAddress,
        wif,
        feeRate.value
      );

      const txid = await electrumWorker.value.broadcast(result.rawTx);
      await db.vault.where({ txid: vault.txid, vout: vault.vout }).modify({ claimed: 1 });
      await db.broadcast.put({ txid, date: Date.now(), description: "vault_claim" });

      toast({
        title: t`Vault Claimed`,
        description: `${txid.slice(0, 8)}…`,
        status: "success",
      });
    } catch (err: unknown) {
      toast({
        title: t`Claim Failed`,
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    }
  };

  // ────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────
  return (
    <ContentContainer>
      <PageHeader>{t`Vault`}</PageHeader>

      {/* Tabs */}
      <HStack mb={6} gap={2}>
        <Button
          size="sm"
          variant={tab === "list" ? "primary" : "ghost"}
          onClick={() => setTab("list")}
        >
          {t`My Vaults`}
        </Button>
        <Button
          size="sm"
          variant={tab === "create" ? "primary" : "ghost"}
          onClick={() => setTab("create")}
        >
          {t`Create Vault`}
        </Button>
      </HStack>

      {/* ───────── CREATE TAB ───────── */}
      {tab === "create" && (
        <VStack gap={4} align="stretch" maxW="600px">
          <FormControl>
            <FormLabel>{t`Recipient Address`}</FormLabel>
            <HStack>
              <Input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="Radiant address"
                fontFamily="mono"
                size="sm"
              />
              <Button size="sm" onClick={fillSelf} variant="solid">
                {t`Self`}
              </Button>
            </HStack>
          </FormControl>

          <SimpleGrid columns={2} gap={4}>
            <FormControl>
              <FormLabel>{t`Asset Type`}</FormLabel>
              <Select
                size="sm"
                value={assetType}
                onChange={(e) =>
                  setAssetType(e.target.value as VaultAssetType)
                }
              >
                <option value="rxd">RXD</option>
                <option value="nft">NFT</option>
                <option value="ft">FT</option>
              </Select>
            </FormControl>

            <FormControl>
              <FormLabel>{t`Lock Mode`}</FormLabel>
              <Select
                size="sm"
                value={mode}
                onChange={(e) => setMode(e.target.value as VaultMode)}
              >
                <option value="block">{t`Block Height`}</option>
                <option value="time">{t`Unix Timestamp`}</option>
              </Select>
            </FormControl>
          </SimpleGrid>

          {assetType !== "rxd" && (
            <FormControl>
              <FormLabel>{t`Token Ref (LE hex)`}</FormLabel>
              <Input
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="72 character hex"
                fontFamily="mono"
                size="sm"
              />
            </FormControl>
          )}

          <FormControl display="flex" alignItems="center" gap={2}>
            <Switch
              isChecked={vesting}
              onChange={(e) => setVesting(e.target.checked)}
            />
            <FormLabel mb={0}>{t`Vesting Schedule`}</FormLabel>
          </FormControl>

          {!vesting ? (
            <SimpleGrid columns={2} gap={4}>
              <FormControl>
                <FormLabel>
                  {mode === "block" ? t`Lock Until Block` : t`Lock Until (Unix)`}
                </FormLabel>
                <Input
                  size="sm"
                  value={locktime}
                  onChange={(e) => setLocktime(e.target.value)}
                  placeholder={
                    mode === "block"
                      ? `Max ${VAULT_MAX_LOCKTIME_BLOCKS}`
                      : "Unix timestamp"
                  }
                />
              </FormControl>
              <FormControl>
                <FormLabel>{t`Amount (RXD)`}</FormLabel>
                <Input
                  size="sm"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                />
              </FormControl>
            </SimpleGrid>
          ) : (
            <VStack gap={2} align="stretch">
              <Heading size="xs">{t`Tranches`} ({tranches.length}/{VAULT_MAX_TRANCHES})</Heading>
              {tranches.map((tr, i) => (
                <HStack key={i} gap={2}>
                  <Input
                    flex={1}
                    size="sm"
                    value={tr.locktime}
                    onChange={(e) =>
                      updateTranche(i, "locktime", e.target.value)
                    }
                    placeholder={
                      mode === "block" ? `Block #${i + 1}` : `Timestamp #${i + 1}`
                    }
                  />
                  <Input
                    flex={1}
                    size="sm"
                    value={tr.value}
                    onChange={(e) =>
                      updateTranche(i, "value", e.target.value)
                    }
                    placeholder="Amount (RXD)"
                  />
                  <IconButton
                    aria-label="Remove"
                    icon={<TbTrash />}
                    size="sm"
                    variant="ghost"
                    isDisabled={tranches.length <= 1}
                    onClick={() => removeTranche(i)}
                  />
                </HStack>
              ))}
              {tranches.length < VAULT_MAX_TRANCHES && (
                <Button
                  size="xs"
                  variant="ghost"
                  leftIcon={<TbPlus />}
                  onClick={addTranche}
                  alignSelf="flex-start"
                >
                  {t`Add Tranche`}
                </Button>
              )}
            </VStack>
          )}

          <FormControl>
            <FormLabel>{t`Label (optional)`}</FormLabel>
            <Input
              size="sm"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Savings, Vesting Q1"
            />
          </FormControl>

          <Button
            variant="primary"
            isLoading={loading}
            onClick={handleCreate}
            mt={2}
          >
            {vesting ? t`Create Vesting Schedule` : t`Lock in Vault`}
          </Button>
        </VStack>
      )}

      {/* ───────── LIST TAB ───────── */}
      {tab === "list" && (
        <Box overflowX="auto">
          {!vaults || vaults.length === 0 ? (
            <Text color="whiteAlpha.500" py={8} textAlign="center">
              {t`No vaults yet. Create one to get started.`}
            </Text>
          ) : (
            <Table size="sm" variant="simple">
              <Thead>
                <Tr>
                  <Th>{t`Status`}</Th>
                  <Th>{t`Type`}</Th>
                  <Th>{t`Value`}</Th>
                  <Th>{t`Unlock At`}</Th>
                  <Th>{t`Remaining`}</Th>
                  <Th>{t`Label`}</Th>
                  <Th />
                </Tr>
              </Thead>
              <Tbody fontFamily="mono">
                {vaults.map((v) => {
                  const unlockable = isVaultUnlockable(
                    v.locktime,
                    v.mode,
                    currentHeight,
                    currentTimestamp
                  );
                  const remaining = vaultTimeRemaining(
                    v.locktime,
                    v.mode,
                    currentHeight,
                    currentTimestamp
                  );
                  const isRecipient =
                    v.recipientAddress === wallet.value.address;

                  return (
                    <Tr
                      key={`${v.txid}-${v.vout}`}
                      opacity={v.claimed ? 0.4 : 1}
                    >
                      <Td>
                        {v.claimed ? (
                          <Tag size="sm" colorScheme="gray">
                            {t`Claimed`}
                          </Tag>
                        ) : unlockable ? (
                          <Tag size="sm" colorScheme="green">
                            <Icon as={TbLockOpen} mr={1} />
                            {t`Unlockable`}
                          </Tag>
                        ) : (
                          <Tag size="sm" colorScheme="orange">
                            <Icon as={TbLock} mr={1} />
                            {t`Locked`}
                          </Tag>
                        )}
                      </Td>
                      <Td textTransform="uppercase">{v.assetType}</Td>
                      <Td>
                        <Photons value={v.value} />
                      </Td>
                      <Td>{formatLocktime(v.locktime, v.mode)}</Td>
                      <Td>
                        {v.claimed
                          ? "—"
                          : remaining.value === 0
                          ? t`Now`
                          : remaining.unit === "blocks"
                          ? `${remaining.value.toLocaleString()} blocks`
                          : `${Math.ceil(remaining.value / 3600)}h`}
                      </Td>
                      <Td>
                        <Text fontSize="xs" noOfLines={1} maxW="120px">
                          {v.label || "—"}
                        </Text>
                      </Td>
                      <Td>
                        {!v.claimed && unlockable && isRecipient && (
                          <Button
                            size="xs"
                            variant="primary"
                            onClick={() => handleClaim(v)}
                          >
                            {t`Claim`}
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          )}
        </Box>
      )}
    </ContentContainer>
  );
}
