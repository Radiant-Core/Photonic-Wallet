/**
 * On-chain regtest validation of the SPV inclusion gate (audit fix R1 / R14).
 *
 * Proves, against the live regtest stack, that the SHIPPED `verifyTxInclusion`
 * (the primitive `app/src/electrum/worker/verifyTxo.ts` gates "confirmed" on):
 *   1. ACCEPTS a real `blockchain.transaction.get_merkle` proof from ElectrumX
 *      checked against the real 80-byte Radiant block header — including the
 *      Radiant-specific dsha512_256 proof-of-work check (checkPow: true).
 *   2. REJECTS a tampered sibling hash, a wrong leaf position, and a header
 *      whose Merkle root doesn't match — i.e. a malicious server cannot forge
 *      a confirmation.
 *
 * Requires the local regtest stack: radiantd RPC 127.0.0.1:17443 + RXinDexer
 * ElectrumX TCP 127.0.0.1:50010. Skipped by default; enable with:
 *   REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run \
 *     src/__tests__/spv.regtest.test.ts --testTimeout=120000
 */
import { it, expect } from "vitest";
import net from "node:net";
import { hexToBytes } from "@noble/hashes/utils";
import {
  verifyTxInclusion,
  verifyHeaderTarget,
  extractMerkleRoot,
} from "../spv";

const RPC_URL = "http://127.0.0.1:17443/";
const RPC_USER = "radiantrpc";
const RPC_PASS = "613c41227c677d8bc90f5729f93604a7";
const ELECTRUM_HOST = "127.0.0.1";
const ELECTRUM_PORT = 50010;

let rpcId = 0;
async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization:
        "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64"),
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: rpcId++, method, params }),
  });
  const json = (await res.json()) as { result: T; error: unknown };
  if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal newline-delimited JSON ElectrumX client over raw TCP. */
function electrumClient(host: string, port: number) {
  const sock = net.connect(port, host);
  sock.setEncoding("utf8");
  let buf = "";
  let eid = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  sock.on("data", (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const p = msg.id != null && pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    }
  });
  const ready = new Promise<void>((res, rej) => {
    sock.on("connect", () => res());
    sock.on("error", rej);
  });
  return {
    ready,
    req<T = any>(method: string, params: unknown[] = []): Promise<T> {
      const myId = eid++;
      return new Promise<T>((resolve, reject) => {
        pending.set(myId, { resolve, reject });
        sock.write(JSON.stringify({ id: myId, method, params }) + "\n");
        setTimeout(() => {
          if (pending.has(myId)) {
            pending.delete(myId);
            reject(new Error(`electrum timeout: ${method}`));
          }
        }, 10_000);
      });
    },
    end() {
      sock.end();
    },
  };
}

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "SPV gate: accepts a real ElectrumX merkle proof + real header, rejects forgeries",
  async () => {
    // 1. Produce a block containing >=2 txs so the Merkle branch is non-trivial.
    const mineAddr = await rpc<string>("getnewaddress");
    if ((await rpc<number>("getbalance")) < 1) {
      await rpc("generatetoaddress", [110, mineAddr]); // mature a coinbase
    }
    const payAddr = await rpc<string>("getnewaddress");
    const txid = await rpc<string>("sendtoaddress", [payAddr, 1]);
    const [blockHash] = await rpc<string[]>("generatetoaddress", [1, mineAddr]);
    const block = await rpc<{ height: number; tx: string[] }>("getblock", [blockHash]);
    const height = block.height;
    expect(block.tx.length).toBeGreaterThanOrEqual(2);
    expect(block.tx).toContain(txid);

    // 2. Real 80-byte header from the node (authoritative, independent of the indexer).
    const headerHex = await rpc<string>("getblockheader", [blockHash, false]);
    const header = hexToBytes(headerHex);
    expect(header.length).toBe(80);

    // 3. Wait out indexer lag, then fetch the Merkle proof from ElectrumX.
    const e = electrumClient(ELECTRUM_HOST, ELECTRUM_PORT);
    await e.ready;
    try {
      await e.req("server.version", ["photonic-regtest", "1.4"]).catch(() => undefined);
      let indexed = false;
      for (let i = 0; i < 60; i++) {
        try {
          await e.req("blockchain.block.header", [height]);
          indexed = true;
          break;
        } catch {
          await sleep(1000);
        }
      }
      expect(indexed).toBe(true);

      const proof = await e.req<{ block_height: number; merkle: string[]; pos: number }>(
        "blockchain.transaction.get_merkle",
        [txid, height]
      );
      expect(proof.block_height).toBe(height);
      expect(proof.merkle.length).toBeGreaterThan(0); // non-trivial branch

      // 4a. POSITIVE: shipped verifier accepts the real proof AND the real
      //     header's Radiant dsha512_256 PoW.
      expect(verifyHeaderTarget(header)).toBe(true);
      const ok = verifyTxInclusion({
        txid,
        merkle: proof.merkle,
        pos: proof.pos,
        header,
        checkPow: true,
      });
      expect(ok.valid).toBe(true);

      // Sanity: folded root equals the header's committed Merkle root.
      const root = extractMerkleRoot(header);
      expect(root).toMatch(/^[0-9a-f]{64}$/);

      // 4b. NEGATIVE: tampered sibling hash -> merkle-mismatch.
      const tampered = [...proof.merkle];
      tampered[0] = (tampered[0][0] === "f" ? "0" : "f") + tampered[0].slice(1);
      expect(
        verifyTxInclusion({ txid, merkle: tampered, pos: proof.pos, header, checkPow: true }).valid
      ).toBe(false);

      // 4c. NEGATIVE: wrong leaf position -> merkle-mismatch.
      expect(
        verifyTxInclusion({ txid, merkle: proof.merkle, pos: proof.pos ^ 1, header, checkPow: true }).valid
      ).toBe(false);

      // 4d. NEGATIVE: a real proof against the WRONG block's header (the
      //     parent) must not verify -> a server can't swap in a stale header.
      const prevHeaderHex = await rpc<string>("getblockheader", [block["previousblockhash" as keyof typeof block] as unknown as string, false]).catch(async () => {
        const full = await rpc<{ previousblockhash: string }>("getblock", [blockHash]);
        return rpc<string>("getblockheader", [full.previousblockhash, false]);
      });
      const prevHeader = hexToBytes(prevHeaderHex);
      expect(
        verifyTxInclusion({ txid, merkle: proof.merkle, pos: proof.pos, header: prevHeader, checkPow: true }).valid
      ).toBe(false);

      console.log(
        `SPV regtest OK — tx ${txid.slice(0, 12)}… proven in block ${height} ` +
          `(branch len ${proof.merkle.length}); forgeries rejected.`
      );
    } finally {
      e.end();
    }
  },
  120_000
);
