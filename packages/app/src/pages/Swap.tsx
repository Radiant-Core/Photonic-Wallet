import Card from "@app/components/Card";
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Container,
  Flex,
  Grid,
  GridItem,
  Heading,
  HStack,
  Icon,
  IconButton,
  Image,
  Input,
  InputGroup,
  InputRightAddon,
  Radio,
  RadioGroup,
  Stack,
  useToast,
} from "@chakra-ui/react";
import { MdOutlineSwapVert } from "react-icons/md";
import { DeleteIcon } from "@chakra-ui/icons";
import TokenSearch from "@app/components/TokenSearch";
import {
  ContractType,
  SmartToken,
  SmartTokenType,
  SwapError,
  SwapMode,
  SwapStatus,
} from "@app/types";
import { PropsWithChildren, useEffect, useState } from "react";
import TokenContent from "@app/components/TokenContent";
import rxdIcon from "/rxd.png";
import { useLocation } from "react-router-dom";
import { ftScript, nftScript, p2pkhScript } from "@lib/script";
import { feeRate, openModal, wallet } from "@app/signals";
import { fundTx, SelectableInput } from "@lib/coinSelect";
import db from "@app/db";
import {
  partiallySigned,
  TransferError,
  transferFungible,
  transferNonFungible,
  transferRadiant,
} from "@lib/transfer";
import { reverseRef } from "@lib/Outpoint";
import {
  updateFtBalances,
  updateRxdBalances,
  updateWalletUtxos,
} from "@app/utxos";
import { electrumWorker } from "@app/electrum/Electrum";
import ViewSwap from "@app/components/ViewSwap";
import {
  assetToSwapTokenId,
  encodePriceTermsOutputs,
  getSwapRpcConfig,
  isSwapIndexAvailable,
  setSwapRpcConfig,
  RSWP_VERSION_V2,
  RSWP_VERSION_V3,
  RSWP_FLAG_HAS_EXPIRY,
} from "@app/swapBroadcast";
import { encodeExpiryHeight } from "@lib/swapRefundCovenant";
import rjs from "@radiant-core/radiantjs";
import { buildTx } from "@lib/tx";
import { findTokenOutput } from "@lib/tx";
import { Buffer } from "buffer";
import Big from "big.js";

// Number of blocks ahead (~30 days at ~600s/block) used as the default
// maker-chosen consensus expiry for RSWP v3 offers. Mirrors the soft-expiry
// window in swapExpiry.ts so the on-chain and client expiries line up.
const SWAP_DEFAULT_EXPIRY_AHEAD_BLOCKS = 4320;

// Whether to reserve the offered asset into the RSWP v3 timelocked-refund
// COVENANT (@lib/swapRefundCovenant) rather than the plain swap-address script.
//
// OFF by default and intentionally so: reserving into the covenant changes the
// reserved UTXO's on-chain shape, which the wallet's existing swap *discovery*
// (electrumWorker.findSwaps), maker *cancellation* (swap.ts cancelSwap),
// pending-swap *reconciliation* (swap.ts syncSwaps), and the taker *completion*
// path (SwapLoad.tsx, which reuses the maker scriptSig verbatim) all assume to
// be a plain ftScript/nftScript/p2pkh at the swap address. Those paths must be
// made covenant-aware (and the Radiant Core swapindex + RXinDexer v3 parsers
// shipped) BEFORE this is flipped on — see the cross-repo coordination note in
// docs/swap-offer-expiry-cancellation.md §4. The covenant + v3 wire format are
// fully implemented and regtest-proven (packages/lib/src/swapRefundCovenant.ts
// + its .regtest.test.ts); only the wallet-wide migration of those four v2
// assumptions remains, which is deliberately out of scope for this change.
//
// While OFF, the maker publishes a plain v2 advertisement (no on-chain expiry)
// and the existing soft expiry (swapExpiry.ts) applies, exactly as before.
const SWAP_RESERVE_INTO_REFUND_COVENANT = false;

// Decimal-safe RXD -> photons conversion. Plain `rxd * 100000000` on a JS float
// yields non-integer photon values (e.g. 0.07 -> 7000000.000000001); Big()
// matches the rest of the wallet (see components/SendRXD.tsx).
function rxdToPhotons(rxd: number): number {
  return Number(Big(rxd).times(100000000).round(0, 0).toString());
}

const { Opcode, Script } = rjs;

export class SwapPrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapPrepareError";
    Object.setPrototypeOf(this, SwapPrepareError.prototype);
  }
}

// Move fungible tokens to swap address
async function prepareFungible(
  coins: SelectableInput[],
  refLE: string,
  asset: Asset
) {
  const fromScript = ftScript(wallet.value.address, refLE);
  const tokens = await db.txo.where({ script: fromScript, spent: 0 }).toArray();
  const { tx, selected } = transferFungible(
    coins,
    tokens,
    refLE,
    wallet.value.address,
    wallet.value.swapAddress,
    asset.value,
    feeRate.value,
    wallet.value.wif!.toString()
  );
  const rawTx = tx.toString();
  const txid = await electrumWorker.value.broadcast(rawTx);
  db.broadcast.put({
    txid,
    date: Date.now(),
    description: "ft_swap_prepare",
  });
  const changeScript = p2pkhScript(wallet.value.address);
  await updateWalletUtxos(
    ContractType.FT,
    fromScript, // FT change
    changeScript, // RXD change
    txid,
    selected.inputs,
    selected.outputs
  );
  updateFtBalances(new Set([fromScript]));
  return tx;
}

// Move NFT to swap address
async function prepareNonFungible(
  coins: SelectableInput[],
  refLE: string,
  asset: Asset
) {
  const fromScript = nftScript(wallet.value.address, refLE);
  const nft = await db.txo.where({ script: fromScript, spent: 0 }).first();
  if (!nft) {
    throw new SwapPrepareError("Token not found");
  }
  const { tx, selected } = transferNonFungible(
    coins,
    nft,
    refLE,
    wallet.value.address,
    wallet.value.swapAddress,
    feeRate.value,
    wallet.value.wif!.toString()
  );
  const rawTx = tx.toString();
  const txid = await electrumWorker.value.broadcast(rawTx);
  db.broadcast.put({
    txid,
    date: Date.now(),
    description: "nft_swap_prepare",
  });
  const changeScript = p2pkhScript(wallet.value.address);

  await updateWalletUtxos(
    ContractType.NFT,
    fromScript,
    changeScript,
    txid,
    selected.inputs,
    selected.outputs
  );

  if (asset.glyph.id) {
    await db.glyph.update(asset.glyph.id, {
      swapPending: true,
    });
  }

  return tx;
}

// Move RXD to swap address
async function prepareRadiant(coins: SelectableInput[], value: number) {
  const { tx, selected } = transferRadiant(
    coins,
    wallet.value.address,
    p2pkhScript(wallet.value.swapAddress),
    value,
    feeRate.value,
    wallet.value.wif!.toString()
  );

  const rawTx = tx.toString();
  const txid = await electrumWorker.value.broadcast(rawTx);
  db.broadcast.put({
    txid,
    date: Date.now(),
    description: "rxd_swap_prepare",
  });

  // Update UTXOs without waiting for subscription
  const changeScript = p2pkhScript(wallet.value.address);
  await updateWalletUtxos(
    ContractType.RXD,
    changeScript,
    changeScript,
    txid,
    selected.inputs,
    selected.outputs
  );
  return tx;
}

const Row = ({
  name,
  tokenType,
  ticker,
  icon,
  onChangeValue,
  onDelete,
  step,
}: {
  name: string;
  tokenType?: SmartTokenType;
  ticker: string;
  icon: React.ReactElement;
  onChangeValue: React.ChangeEventHandler<HTMLInputElement>;
  onDelete?: React.MouseEventHandler<HTMLDivElement>;
  step?: string;
}) => {
  return (
    <Grid
      templateColumns={{ base: "40px auto auto", md: "40px 1fr 300px 40px" }}
      templateRows={{ base: "24px 72px", md: "72px" }}
      columnGap={2}
      px={4}
      alignItems="center"
      bg="surface.raised"
      borderRadius="md"
    >
      <GridItem>{icon}</GridItem>
      <GridItem
        fontSize={{ base: "sm", md: "md" }}
        colSpan={{ base: 3, md: "auto" }}
        order={{ base: -1, md: "unset" }}
        sx={{ textWrap: "nowrap" }}
        overflow="hidden"
        textOverflow="ellipsis"
      >
        {name}
      </GridItem>
      {tokenType === SmartTokenType.NFT ? (
        <Box />
      ) : (
        <GridItem as={InputGroup}>
          <Input
            placeholder="0"
            type="number"
            onChange={onChangeValue}
            minW={16}
            step={step || "1"}
          />
          <InputRightAddon>
            {ticker.length > 0 ? ticker : "TOKEN"}
          </InputRightAddon>
        </GridItem>
      )}
      <GridItem
        as={IconButton}
        icon={<DeleteIcon />}
        onClick={onDelete}
        disabled={!onDelete}
      ></GridItem>
    </Grid>
  );
};

type Asset = {
  glyph: SmartToken;
  value: number;
};

function encodeScriptNum(value: number) {
  if (value === 0) {
    return Buffer.alloc(0);
  }

  const result: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    result.push(remaining & 0xff);
    remaining >>= 8;
  }

  if (result[result.length - 1] & 0x80) {
    result.push(0);
  }

  return Buffer.from(result);
}

/**
 * Build the RSWP swap advertisement OP_RETURN.
 *
 * v2 layout (legacy, no expiry):
 *   "RSWP" 0x02 <flags:1> <offeredType:1> 0x01 <tokenid:32LE>
 *     [wantTokenid:32LE if flags&0x01] <txid:32LE> <vout> <priceTerms> <signature>
 *
 * v3 layout (this build) — adds a 4-byte LE `expiry_height` immediately AFTER
 * the want-token id (i.e. before the outpoint) and sets flag bit 0x02:
 *   "RSWP" 0x03 <flags:1> <offeredType:1> 0x01 <tokenid:32LE>
 *     [wantTokenid:32LE if flags&0x01] <expiry_height:4LE if flags&0x02>
 *     <txid:32LE> <vout> <priceTerms> <signature>
 *
 * Parsers that understand only v2 will see version byte 0x03 and must skip the
 * advertisement (forward-incompatible) — hence the cross-repo coordination note
 * in docs/swap-offer-expiry-cancellation.md §4: land the index/RXinDexer v3
 * parsers BEFORE makers publish v3. `signature` is read to the end of payload.
 */
function buildSwapAdvertisementScript({
  offeredType,
  offeredTokenId,
  wantTokenId,
  offeredTxid,
  offeredVout,
  priceTerms,
  signature,
  expiryHeight,
}: {
  offeredType: ContractType;
  offeredTokenId: string;
  wantTokenId: string;
  offeredTxid: string;
  offeredVout: number;
  priceTerms: string;
  signature: string;
  /** Absolute block height for RSWP v3; omit/undefined to emit a v2 advert. */
  expiryHeight?: number;
}) {
  const hasWantToken = wantTokenId !== "00".repeat(32);
  const hasExpiry =
    expiryHeight !== undefined && Number.isInteger(expiryHeight) && expiryHeight > 0;
  const version = hasExpiry ? RSWP_VERSION_V3 : RSWP_VERSION_V2;
  const flags =
    (hasWantToken ? 0x01 : 0x00) | (hasExpiry ? RSWP_FLAG_HAS_EXPIRY : 0x00);

  const script = new Script()
    .add(Opcode.OP_RETURN)
    .add(Buffer.from("RSWP"))
    .add(Buffer.from([version]))
    .add(Buffer.from([flags]))
    .add(Buffer.from([offeredType]))
    .add(Buffer.from([0x01]))
    .add(Buffer.from(offeredTokenId, "hex").reverse());

  if (hasWantToken) {
    script.add(Buffer.from(wantTokenId, "hex").reverse());
  }

  if (hasExpiry) {
    // 4-byte little-endian unsigned block height.
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(expiryHeight, 0);
    script.add(buf);
  }

  return script
    .add(Buffer.from(offeredTxid, "hex").reverse())
    .add(encodeScriptNum(offeredVout))
    .add(Buffer.from(priceTerms, "hex"))
    .add(Buffer.from(signature, "hex"));
}

function OutputSelection({
  heading,
  asset,
  setAsset,
  setRxd,
}: {
  heading: string;
  asset: Asset | null;
  setAsset: React.Dispatch<React.SetStateAction<Asset | null>>;
  setRxd: React.Dispatch<React.SetStateAction<number>>;
}) {
  const onChangeValue = (value: string) => {
    if (asset) {
      setAsset({ glyph: asset?.glyph, value: parseInt(value, 10) });
    }
  };

  const add = (glyph: SmartToken) => {
    setAsset({ glyph, value: 0 });
  };

  const remove = () => {
    setAsset(null);
  };

  return (
    <Card as={Flex} p={{ base: 4, md: 8 }}>
      <Heading textStyle="h3" pb={4} pl={2}>
        {heading}
      </Heading>
      <Flex flexDir="column" gap={2} mb={4}>
        {asset ? (
          <Row
            key={asset.glyph.id}
            name={asset.glyph.name}
            tokenType={asset.glyph.tokenType}
            ticker={asset.glyph.ticker || ""}
            icon={<TokenContent glyph={asset.glyph} thumbnail />}
            onChangeValue={(event) => {
              onChangeValue(event.target.value);
            }}
            onDelete={() => remove()}
          />
        ) : (
          <Row
            key="rxd"
            name="Radiant"
            ticker="RXD"
            icon={<Image src={rxdIcon} width={8} height={8} />}
            onChangeValue={(event) => {
              setRxd(Number(event.target.value));
            }}
            step="0.00000001"
          />
        )}
      </Flex>
      <TokenSearch onSelect={add} />
    </Card>
  );
}

export default function SwapPage() {
  const location = useLocation();
  // Use location key to reset the page when clicking "new"
  return <Swap key={location.key} />;
}

const ViewFooter = ({ children }: PropsWithChildren) => {
  return (
    <Flex
      justifyContent="center"
      py={8}
      gap={4}
      flexDir={{ base: "column", md: "row" }}
    >
      {children}
    </Flex>
  );
};

function Swap() {
  // Old wallets (saved before swapAddress existed) are covered: decryptKeys()
  // re-derives swapAddress from the HD seed on every unlock (keys.ts), so
  // wallet.value.swapAddress is always populated by the time a swap can be
  // signed — no per-page backfill needed here.
  const location = useLocation();
  const toast = useToast();
  const [send, setSend] = useState<Asset | null>(null);
  const [sendRxd, setSendRxd] = useState(0);
  const [receive, setReceive] = useState<Asset | null>(null);
  const [receiveRxd, setReceiveRxd] = useState(0);
  const [psrt, setPsrt] = useState("");
  const [mode, setMode] = useState<SwapMode>(SwapMode.PRIVATE);
  const [broadcastTxid, setBroadcastTxid] = useState("");
  const [rpcUrl, setRpcUrl] = useState(getSwapRpcConfig().url);
  const [preparing, setPreparing] = useState(false);

  // Pre-fill the offered asset when navigated here from a "List for Sale"
  // action (e.g. the WAVE Names page passes the name's ref in route state).
  // SwapPage remounts this component per location.key, so this runs once.
  useEffect(() => {
    const offerGlyphRef = (location.state as { offerGlyphRef?: string } | null)
      ?.offerGlyphRef;
    if (!offerGlyphRef) return;
    let cancelled = false;
    (async () => {
      const glyph = await db.glyph.where({ ref: offerGlyphRef }).first();
      if (!cancelled && glyph) {
        setSend({ glyph, value: 0 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [location.state]);

  const saveRpcUrl = () => {
    const trimmed = rpcUrl.trim();
    if (!trimmed) {
      toast({ status: "error", title: "RPC URL cannot be empty" });
      return;
    }
    setSwapRpcConfig({ url: trimmed });
    toast({
      status: "success",
      title: "Swap RPC endpoint saved",
      description: trimmed,
    });
  };

  const validateSwap = () => {
    const sendIsRxd = !send;
    const receiveIsRxd = !receive;

    if (sendIsRxd && sendRxd <= 0) {
      throw new SwapPrepareError("Enter an RXD amount to send");
    }

    if (receiveIsRxd && receiveRxd <= 0) {
      throw new SwapPrepareError("Enter an RXD amount to receive");
    }

    if (send && send.glyph.tokenType === SmartTokenType.FT && send.value <= 0) {
      throw new SwapPrepareError("Enter a token amount to send");
    }

    if (
      receive &&
      receive.glyph.tokenType === SmartTokenType.FT &&
      receive.value <= 0
    ) {
      throw new SwapPrepareError("Enter a token amount to receive");
    }

    if (send && receive && send.glyph.ref === receive.glyph.ref) {
      throw new SwapPrepareError("Send and receive assets must be different");
    }

    if (sendIsRxd && receiveIsRxd) {
      throw new SwapPrepareError("A swap cannot be RXD for RXD");
    }
  };

  const prepareTransaction = async () => {
    if (preparing) return;
    // Inline unlock: the wallet may have idle-locked while the form was open.
    // Prompt for the password in place and resume preparing the swap, rather
    // than forcing the user to back out and unlock from the sidebar.
    if (wallet.value.locked || !wallet.value.swapWif || !wallet.value.wif) {
      openModal.value = {
        modal: "unlock",
        onClose: (unlocked) => {
          if (unlocked) prepareTransaction();
        },
      };
      return;
    }
    setPreparing(true);
    try {
      await runPrepareTransaction();
    } finally {
      setPreparing(false);
    }
  };

  const runPrepareTransaction = async () => {
    const coins: SelectableInput[] = await db.txo
      .where({ contractType: ContractType.RXD, spent: 0 })
      .toArray();

    try {
      validateSwap();
    } catch (error) {
      if (error instanceof SwapPrepareError) {
        toast({ status: "error", title: error.message });
        return;
      }
      throw error;
    }

    let tx;
    let from: ContractType;
    let fromValue: number;
    try {
      if (send) {
        // Token to RXD
        const refLE = reverseRef(send.glyph.ref);

        if (send.glyph.tokenType === SmartTokenType.FT) {
          tx = await prepareFungible(coins, refLE, send);
          from = ContractType.FT;
          fromValue = send.value;
        } else {
          tx = await prepareNonFungible(coins, refLE, send);
          from = ContractType.NFT;
          fromValue = 1;
        }
      } else {
        const sendRxdPhotons = rxdToPhotons(sendRxd);
        tx = await prepareRadiant(coins, sendRxdPhotons);
        from = ContractType.RXD;
        fromValue = sendRxdPhotons;
      }
    } catch (error) {
      if (error instanceof TransferError || error instanceof SwapError) {
        toast({ status: "error", title: error.message });
      } else {
        toast({ status: "error", title: "Failed to create transaction" });
      }
      console.debug(error);
      return;
    }

    let psrtOutput;
    let to: ContractType;
    let toValue: number;
    if (receive) {
      const refLE = reverseRef(receive.glyph.ref);
      if (receive.glyph.tokenType === SmartTokenType.FT) {
        psrtOutput = {
          script: ftScript(wallet.value.address, refLE),
          value: receive.value,
        };
        to = ContractType.FT;
        toValue = receive.value;
      } else {
        psrtOutput = {
          script: nftScript(wallet.value.address, refLE),
          value: 1,
        };
        to = ContractType.NFT;
        toValue = 1;
      }
    } else {
      const receiveRxdPhotons = rxdToPhotons(receiveRxd);
      psrtOutput = {
        script: p2pkhScript(wallet.value.address),
        value: receiveRxdPhotons,
      };
      to = ContractType.RXD;
      toValue = receiveRxdPhotons;
    }

    if (!tx) {
      // Defensive: the prepare* helpers above either return a tx or throw (the
      // throw is toasted in the catch). If we still have no tx, surface it
      // rather than returning silently and leaving the button stuck.
      toast({ status: "error", title: "Failed to create transaction" });
      return;
    }

    updateRxdBalances(wallet.value.address);

    const swapOutput = (() => {
      if (from === ContractType.RXD) {
        const swapScript = p2pkhScript(wallet.value.swapAddress);
        const vout = tx.outputs.findIndex(
          (output) => output.script.toHex() === swapScript
        );
        if (vout < 0) {
          throw new SwapPrepareError(
            "Could not locate reserved RXD swap output"
          );
        }
        return { vout, output: tx.outputs[vout] };
      }

      if (!send?.glyph?.ref) {
        throw new SwapPrepareError("Missing offered token reference");
      }

      const refLE = reverseRef(send.glyph.ref);
      if (from === ContractType.FT) {
        const found = findTokenOutput(tx, refLE, (script) => {
          const parsed = ftScript(wallet.value.swapAddress, refLE);
          if (script === parsed) {
            return { ref: refLE };
          }
          return {};
        });
        if (found.vout === undefined || !found.output) {
          throw new SwapPrepareError(
            "Could not locate reserved fungible swap output"
          );
        }
        return { vout: found.vout, output: found.output };
      }

      const found = findTokenOutput(tx, refLE);
      if (found.vout === undefined || !found.output) {
        throw new SwapPrepareError("Could not locate reserved NFT swap output");
      }
      return { vout: found.vout, output: found.output };
    })();

    const input = {
      txid: tx.id,
      vout: swapOutput.vout,
      script: swapOutput.output.script.toHex(),
      value: swapOutput.output.satoshis,
    };

    // Build Partially Signed Radiant Transaction.
    //
    // SECURITY (swap-offer liveness): the PSRT is signed with
    // SIGHASH_SINGLE|ANYONECANPAY, so it has no on-chain expiry and no per-offer
    // cancellation nonce. It stays broadcastable by anyone who holds it — at the
    // originally-signed price — until the maker self-spends the reserved UTXO to
    // cancel it (see swap.ts `cancelSwap`, surfaced as one-click Cancel in the
    // Pending Swaps and Open Orders > My Public Offers views).
    //
    // The consensus-level expiry (RSWP v3 `expiry_height` + a timelocked-refund
    // covenant) is now IMPLEMENTED and regtest-proven in @lib/swapRefundCovenant,
    // and the taker side hard-refuses past-expiry offers (OpenOrders +
    // swapBroadcast `isOfferExpiredOnChain`). Reserving INTO that covenant here
    // is still gated OFF (SWAP_RESERVE_INTO_REFUND_COVENANT) until the wallet's
    // discovery/cancel/sync/load paths are made covenant-aware and the Radiant
    // Core swapindex / RXinDexer v3 parsers ship — see
    // docs/swap-offer-expiry-cancellation.md §7. While gated off, the live
    // mitigations remain:
    //   1. a maker risk warning (below, esp. for public/broadcast offers),
    //   2. one-click cancellation, and
    //   3. a client/index *soft* expiry that hides + flags stale offers
    //      (swapExpiry.ts, Open Orders book).
    // See docs/swap-offer-expiry-cancellation.md for the full design.
    const rawPsrt = partiallySigned(
      wallet.value.swapAddress,
      input,
      psrtOutput,
      wallet.value.swapWif!.toString()
    ).toString();

    let advertisementTxid: string | undefined;
    if (mode === SwapMode.BROADCAST) {
      try {
        const rpcConfig = getSwapRpcConfig();
        let indexAvailable = false;
        try {
          indexAvailable = await isSwapIndexAvailable();
        } catch {
          indexAvailable = false;
        }
        if (!indexAvailable) {
          throw new SwapPrepareError(
            `Swap index not available at ${rpcConfig.url}. Update the Swap RPC endpoint below or connect to a Radiant Core node started with -swapindex=1.`
          );
        }

        const walletRxdScript = p2pkhScript(wallet.value.address);
        const fundingCoins = await db.txo
          .where({ contractType: ContractType.RXD, spent: 0 })
          .toArray();
        const spendableCoins = fundingCoins.filter(
          (coin) =>
            coin.script === walletRxdScript &&
            !(coin.txid === input.txid && coin.vout === input.vout)
        );

        const offeredTokenId = assetToSwapTokenId(from, send?.glyph?.ref);
        const wantTokenId = assetToSwapTokenId(to, receive?.glyph?.ref);
        const makerOutputs = [
          { script: psrtOutput.script, value: psrtOutput.value },
        ];

        // RSWP v3 consensus expiry. We only ADVERTISE an `expiry_height` when
        // the reserved UTXO is actually held in the timelocked-refund covenant
        // that enforces it — otherwise the offer would claim an on-chain expiry
        // it cannot keep. Until the covenant reservation + the cancel/sync/load
        // migration land (see SWAP_RESERVE_INTO_REFUND_COVENANT), this resolves
        // to `undefined` and the advertisement is emitted as v2 (the existing
        // soft expiry in swapExpiry.ts continues to apply).
        let expiryHeight: number | undefined;
        if (SWAP_RESERVE_INTO_REFUND_COVENANT) {
          try {
            const tip = await electrumWorker.value.getBlockHeight();
            const candidate = tip + SWAP_DEFAULT_EXPIRY_AHEAD_BLOCKS;
            // Validate against the covenant's encoder (rejects timestamp-range
            // / non-positive heights) so the advert and covenant never diverge.
            encodeExpiryHeight(candidate);
            expiryHeight = candidate;
          } catch (e) {
            console.debug("[swap] could not derive v3 expiry height; v2 advert", e);
            expiryHeight = undefined;
          }
        }

        const advertisementScript = buildSwapAdvertisementScript({
          offeredType: from,
          offeredTokenId,
          wantTokenId,
          offeredTxid: input.txid,
          offeredVout: input.vout,
          priceTerms: encodePriceTermsOutputs(makerOutputs),
          signature: new rjs.Transaction(rawPsrt).inputs[0].script.toHex(),
          expiryHeight,
        }).toHex();

        const funded = fundTx(
          wallet.value.address,
          spendableCoins,
          [],
          [{ script: advertisementScript, value: 0 }],
          walletRxdScript,
          feeRate.value
        );

        if (!funded.funded) {
          throw new SwapPrepareError(
            "Insufficient RXD to publish the public swap offer"
          );
        }

        const advertisementTx = buildTx(
          wallet.value.address,
          wallet.value.wif!.toString(),
          funded.funding,
          [{ script: advertisementScript, value: 0 }, ...funded.change],
          false
        );

        advertisementTxid = await electrumWorker.value.broadcast(
          advertisementTx.toString()
        );
        setBroadcastTxid(advertisementTxid);
        await db.broadcast.put({
          txid: advertisementTxid,
          date: Date.now(),
          description: "swap_advertisement",
        });
      } catch (error) {
        const message =
          error instanceof SwapPrepareError
            ? error.message
            : error instanceof Error
            ? error.message
            : "Failed to broadcast swap advertisement";
        toast({
          status: "error",
          title: "Broadcast failed",
          description: message,
        });
        console.debug("Broadcast swap failed", error);
        // Private swap was already prepared above; keep it usable instead of
        // losing the signed PSRT. User can retry broadcast or share privately.
        setPsrt(rawPsrt);
        db.swap.put({
          txid: tx.id,
          vout: swapOutput.vout,
          tx: rawPsrt,
          from,
          fromGlyph: send?.glyph?.ref || null,
          fromValue,
          to,
          toGlyph: receive?.glyph?.ref || null,
          toValue,
          status: SwapStatus.PENDING,
          date: Date.now(),
          mode: SwapMode.PRIVATE,
        });
        return;
      }
    }

    setPsrt(rawPsrt);
    toast({
      status: "success",
      title:
        mode === SwapMode.BROADCAST
          ? "Public swap offer broadcast"
          : "Swap transaction created",
    });

    console.debug(rawPsrt);

    db.swap.put({
      txid: tx.id,
      vout: swapOutput.vout,
      tx: rawPsrt,
      from,
      fromGlyph: send?.glyph?.ref || null, // null for RXD
      fromValue,
      to,
      toGlyph: receive?.glyph?.ref || null, // null for RXD
      toValue,
      status: SwapStatus.PENDING,
      date: Date.now(),
      mode,
      broadcastTxid: advertisementTxid,
    });
  };

  if (psrt) {
    return (
      <Container maxW="container.md" px={4} gap={8}>
        <Heading textStyle="h3" pb={4} pl={2}>
          Transaction
        </Heading>
        {broadcastTxid && (
          <Alert status="success" mb={4}>
            <AlertIcon />
            Public swap advertisement broadcast:{" "}
            {broadcastTxid.substring(0, 16)}...
          </Alert>
        )}
        <Alert status="warning" mb={4} fontSize="sm" alignItems="flex-start">
          <AlertIcon />
          <Box>
            This offer stays fillable at the signed price until you cancel it.
            Cancel it from <b>Pending Swaps</b>
            {broadcastTxid ? " or Open Orders → My Public Offers" : ""} to
            reclaim the reserved {send ? "asset" : "coins"} and revoke the
            offer.
          </Box>
        </Alert>
        <ViewSwap
          from={send ? send : rxdToPhotons(sendRxd)}
          to={receive ? receive : rxdToPhotons(receiveRxd)}
          hex={psrt}
          BodyComponent={Card}
          FooterComponent={ViewFooter}
        />
      </Container>
    );
  }

  return (
    <Container maxW="container.md" px={4} gap={8}>
      <OutputSelection
        heading="Send"
        asset={send}
        setAsset={setSend}
        setRxd={setSendRxd}
      />
      <Flex justifyContent="center" py={8}>
        <Icon as={MdOutlineSwapVert} boxSize={8} color="gray.200" />
      </Flex>
      <OutputSelection
        heading="Receive"
        asset={receive}
        setAsset={setReceive}
        setRxd={setReceiveRxd}
      />
      <Alert mt={8}>
        <AlertIcon />
        Tokens or Radiant coins to send will be reserved so they are not spent
        by the wallet. The transaction must be cancelled to make them spendable
        again.
      </Alert>
      <Card>
        <Heading textStyle="h3" pb={4}>
          Offer Type
        </Heading>
        <RadioGroup
          value={mode === SwapMode.BROADCAST ? "broadcast" : "private"}
          onChange={(value) =>
            setMode(
              value === "broadcast" ? SwapMode.BROADCAST : SwapMode.PRIVATE
            )
          }
        >
          <Stack direction={{ base: "column", md: "row" }} spacing={6}>
            <Radio value="private">Private</Radio>
            <Radio value="broadcast">Public (Swap Index)</Radio>
          </Stack>
        </RadioGroup>
        <Alert
          status="warning"
          mt={4}
          fontSize="sm"
          alignItems="flex-start"
          borderRadius="md"
        >
          <AlertIcon />
          <Box>
            {mode === SwapMode.BROADCAST ? (
              <>
                This offer is signed at a <b>fixed price with no expiry</b>.
                Once public, <b>anyone</b> can fill it at these exact terms —
                even weeks later — until you <b>cancel</b> it. Cancel from{" "}
                <b>Open Orders → My Public Offers</b> (or Pending Swaps) when
                the offer is no longer wanted; that is the only way to revoke
                it. The order book hides offers older than ~30 days, but that
                does not stop someone who saved the signed offer.
              </>
            ) : (
              <>
                This offer is signed at a <b>fixed price with no expiry</b>.
                Anyone you share the transaction with can fill it at these exact
                terms at any time until you <b>cancel</b> it from Pending Swaps
                — cancelling (self-spending the reserved coin) is the only way
                to revoke it.
              </>
            )}
          </Box>
        </Alert>
        {mode === SwapMode.BROADCAST && (
          <Stack pt={6} spacing={3}>
            <Heading textStyle="h3" fontSize="sm">
              Swap RPC endpoint
            </Heading>
            <Alert status="info" fontSize="sm">
              <AlertIcon />
              Public offers require a CORS-enabled Radiant Core node with
              <Box as="code" mx={1}>
                -swapindex=1
              </Box>
              . The default hosted endpoint is{" "}
              <Box as="code">https://swap.radiantcore.org</Box>. Override below
              to use your own node.
            </Alert>
            <HStack>
              <Input
                placeholder="https://swap.radiantcore.org"
                value={rpcUrl}
                onChange={(e) => setRpcUrl(e.target.value)}
                size="sm"
              />
              <Button size="sm" onClick={saveRpcUrl}>
                Save
              </Button>
            </HStack>
          </Stack>
        )}
      </Card>
      <Flex
        justifyContent="center"
        py={8}
        gap={4}
        flexDir={{ base: "column", md: "row" }}
      >
        <Button
          variant="primary"
          onClick={prepareTransaction}
          isLoading={preparing}
          loadingText={
            mode === SwapMode.BROADCAST ? "Broadcasting offer…" : "Preparing…"
          }
        >
          Prepare Transaction
        </Button>
      </Flex>
    </Container>
  );
}
