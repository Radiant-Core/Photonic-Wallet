import { useEffect, useRef, useState } from "react";
import { t } from "@lingui/macro";
import {
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  FormControl,
  FormLabel,
  Input,
  Textarea,
  ModalCloseButton,
  UseDisclosureProps,
  Alert,
  AlertDescription,
  AlertIcon,
  useToast,
  VStack,
  HStack,
  IconButton,
  Tag,
  TagLabel,
  TagCloseButton,
  SimpleGrid,
  Text,
} from "@chakra-ui/react";
import { AddIcon } from "@chakra-ui/icons";
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";
import { ContractType, SmartToken, TxO } from "@app/types";
import { feeRate, wallet } from "@app/signals";
import { electrumWorker } from "@app/electrum/Electrum";
import Outpoint from "@lib/Outpoint";
import { encodeGlyphMutable } from "@lib/token";
import { fundTx } from "@lib/coinSelect";
import {
  mutableNftScript,
  nftAuthScript,
  p2pkhScript,
  parseMutableScript,
} from "@lib/script";
import { buildTx, findTokenOutput } from "@lib/tx";
import { SmartTokenPayload, UnfinalizedInput } from "@lib/types";
import { Transaction } from "@radiant-core/radiantjs";

interface Props {
  token: SmartToken;
  txo: TxO;
  onSuccess?: (txid: string) => void;
  disclosure: UseDisclosureProps;
}

export default function EditDigitalObject({
  token,
  txo,
  onSuccess,
  disclosure,
}: Props) {
  const { isOpen, onClose } = disclosure;
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [hasError, setHasError] = useState(false);
  const toast = useToast();

  // Form fields pre-populated with current token data
  const [name, setName] = useState(token.name || "");
  const [description, setDescription] = useState(token.description || "");
  const [attrKey, setAttrKey] = useState("");
  const [attrVal, setAttrVal] = useState("");
  const [attrs, setAttrs] = useState<{ [k: string]: string }>(
    token.attrs || {}
  );
  const attrKeyRef = useRef<HTMLInputElement>(null);

  const rxd = useLiveQuery(
    () => db.txo.where({ contractType: ContractType.RXD, spent: 0 }).toArray(),
    [],
    []
  );

  useEffect(() => {
    if (isOpen) {
      setName(token.name || "");
      setDescription(token.description || "");
      setAttrs(token.attrs || {});
      setAttrKey("");
      setAttrVal("");
      setHasError(false);
      setErrorMessage("");
      setLoading(false);
    }
  }, [isOpen, token]);

  if (!isOpen || !onClose) return null;

  const addAttr = () => {
    const k = attrKey.trim();
    const v = attrVal.trim();
    if (!k || !v) return;
    setAttrs((prev) => ({ ...prev, [k]: v }));
    setAttrKey("");
    setAttrVal("");
    attrKeyRef.current?.focus();
  };

  const removeAttr = (key: string) => {
    setAttrs((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setHasError(false);
    setLoading(true);

    if (!wallet.value.wif) {
      setErrorMessage("Wallet is locked");
      setHasError(true);
      setLoading(false);
      return;
    }

    try {
      const nftRefBE = Outpoint.fromString(token.ref);
      const nftRefLE = nftRefBE.reverse().toString();
      const { txid, vout: refVout } = nftRefBE.toObject();

      // Mutable contract ref is always token ref + 1
      const mutRefBE = Outpoint.fromUTXO(txid, refVout + 1);
      const mutRefLE = mutRefBE.reverse().toString();

      // Fetch current location of the mutable contract UTXO
      const refResponse = await electrumWorker.value.getRef(
        mutRefBE.toString()
      );
      if (!refResponse.length) {
        throw new Error("Mutable contract UTXO not found");
      }
      const location = refResponse[refResponse.length - 1].tx_hash;
      const hex = await electrumWorker.value.getTransaction(location);
      const refTx = new Transaction(hex);

      const { vout: mutVout, output: mutOutput } = findTokenOutput(
        refTx,
        mutRefLE,
        parseMutableScript
      );

      if (mutVout === undefined || !mutOutput) {
        throw new Error("Could not locate mutable contract output");
      }

      // Build updated payload
      const attrsFiltered = Object.keys(attrs).length ? attrs : undefined;
      const payload: Partial<SmartTokenPayload> = {
        name: name.trim() || undefined,
        desc: description.trim() || undefined,
        attrs: attrsFiltered,
      };

      // contractOutputIndex=0 (mutable contract in output 0)
      // refHashIndex=1 (skip the state separator, ref+hash starts at byte 1 in state script; value from script layout)
      // refIndex=0 (first ref in refdatasummary of token output)
      // tokenOutputIndex=1 (NFT token is output 1)
      const glyph = encodeGlyphMutable("mod", payload, 0, 1, 0, 1);
      const mutOutputScript = mutableNftScript(mutRefLE, glyph.payloadHash);
      const nftOutputScript = nftAuthScript(
        wallet.value.address,
        nftRefLE,
        [{ ref: mutRefLE, scriptSigHash: glyph.scriptSigHash }]
      );

      const nftInput: UnfinalizedInput = { ...txo };
      const mutInput: UnfinalizedInput = {
        txid: refTx.id,
        vout: mutVout,
        script: mutOutput.script.toHex(),
        value: mutOutput.satoshis,
        scriptSigSize: mutOutputScript.length / 2,
      };

      const nftOutput = { script: nftOutputScript, value: txo.value };
      const mutContractOutput = {
        script: mutOutputScript,
        value: mutInput.value,
      };

      const inputs: UnfinalizedInput[] = [nftInput, mutInput];
      const outputs = [nftOutput, mutContractOutput];

      const p2pkh = p2pkhScript(wallet.value.address);
      const fund = fundTx(
        wallet.value.address,
        rxd.slice(),
        inputs,
        outputs,
        p2pkh,
        feeRate.value
      );

      if (!fund.funded) {
        throw new Error("Insufficient funds");
      }

      inputs.push(...fund.funding);
      outputs.push(...fund.change);

      const rawTx = buildTx(
        wallet.value.address,
        wallet.value.wif,
        inputs,
        outputs,
        false,
        (index, script) => {
          if (index === 1) {
            // Mutable contract input: replace p2pkh scriptSig with glyph scriptSig
            script.set({ chunks: [] });
            script.add(glyph.scriptSig);
          }
        }
      ).toString();

      const txid2 = await electrumWorker.value.broadcast(rawTx);
      db.broadcast.put({ txid: txid2, date: Date.now(), description: "nft_edit" });

      // Update local glyph record immediately
      if (token.id) {
        await db.glyph.update(token.id, {
          name: name.trim() || token.name,
          description: description.trim(),
          attrs: attrs,
          height: Infinity,
        });
      }

      toast({ status: "success", title: "Token updated" });
      onSuccess && onSuccess(txid2);
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Transaction failed";
      setErrorMessage(msg);
      setHasError(true);
      setLoading(false);
    }
  };

  const attrEntries = Object.entries(attrs);

  return (
    <Modal isOpen={isOpen} onClose={onClose} isCentered size="md">
      <form onSubmit={submit}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{"Edit Token"}</ModalHeader>
          <ModalCloseButton />
          <ModalBody pb={6}>
            <VStack spacing={4} align="stretch">
              {hasError && (
                <Alert status="error">
                  <AlertIcon />
                  <AlertDescription>{errorMessage}</AlertDescription>
                </Alert>
              )}
              <FormControl>
                <FormLabel>{"Name"}</FormLabel>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={"Token name"}
                  maxLength={80}
                />
              </FormControl>
              <FormControl>
                <FormLabel>{"Description"}</FormLabel>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={"Description"}
                  maxLength={1000}
                  rows={3}
                />
              </FormControl>
              <FormControl>
                <FormLabel>{"Attributes"}</FormLabel>
                {attrEntries.length > 0 && (
                  <SimpleGrid columns={2} gap={2} mb={2}>
                    {attrEntries.map(([k, v]) => (
                      <Tag key={k} size="md" borderRadius="full" variant="solid" colorScheme="blue">
                        <TagLabel>
                          <Text as="span" fontWeight="bold">{k}</Text>: {v}
                        </TagLabel>
                        <TagCloseButton onClick={() => removeAttr(k)} />
                      </Tag>
                    ))}
                  </SimpleGrid>
                )}
                <HStack>
                  <Input
                    ref={attrKeyRef}
                    value={attrKey}
                    onChange={(e) => setAttrKey(e.target.value)}
                    placeholder={"Name"}
                    size="sm"
                  />
                  <Input
                    value={attrVal}
                    onChange={(e) => setAttrVal(e.target.value)}
                    placeholder={"Value"}
                    size="sm"
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addAttr())}
                  />
                  <IconButton
                    aria-label={"Add attribute"}
                    icon={<AddIcon />}
                    size="sm"
                    onClick={addAttr}
                  />
                </HStack>
              </FormControl>
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button
              type="submit"
              variant="primary"
              isLoading={loading}
              mr={4}
            >
              {"Update Token"}
            </Button>
            <Button onClick={onClose}>{"Cancel"}</Button>
          </ModalFooter>
        </ModalContent>
      </form>
    </Modal>
  );
}
