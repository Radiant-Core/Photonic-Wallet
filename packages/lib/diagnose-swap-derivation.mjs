// Safe LOCAL diagnostic — finds which HD derivation produces the addresses
// involved in your stuck swap. Your seed stays on this machine and is NOT
// printed. Run from the Photonic-Wallet repo:
//    SEED="your twelve word mnemonic" node diagnose-swap-derivation.mjs
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { createHash } from "crypto";

const SEED = process.env.SEED;
if (!SEED) { console.error("Set SEED env var to your mnemonic"); process.exit(1); }

const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const hash160 = (b) => createHash("ripemd160").update(createHash("sha256").update(b).digest()).digest();
function b58check(payload) {
  const chk = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().slice(0, 4);
  const full = Buffer.concat([payload, chk]);
  let n = BigInt("0x" + full.toString("hex")), out = "";
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of full) { if (byte === 0) out = "1" + out; else break; }
  return out;
}
const addrOf = (pkhHex) => b58check(Buffer.concat([Buffer.from([0x00]), Buffer.from(pkhHex, "hex")]));

const KNOWN = {
  "716477de74200c2e2416177c53aea716f5035ac2": "MAIN (1BLZ…)",
  "350e8568a5d5a9eaf5e62acb48ff8b586d159cb6": ">>> NFT's swap address (15qYD7Y3…) <<<",
  "ab389101e85ec5cfd998a5885fd45098ceaa1cd5": "current swap (1GcL…)",
};

// Collapse any stray whitespace (double spaces, tabs, newlines) and lowercase —
// @scure throws "Invalid mnemonic" when the word count isn't a multiple of 3,
// which is usually just messy spacing, not a wrong phrase.
const words = SEED.trim().replace(/\s+/g, " ").toLowerCase().split(" ").filter(Boolean);
console.log(`(mnemonic word count: ${words.length} — should be 12 or 24)\n`);
const hd = HDKey.fromMasterSeed(mnemonicToSeedSync(words.join(" ")));
let matches = [];
const seen = new Set();
const check = (path) => {
  if (seen.has(path)) return;
  seen.add(path);
  let leaf;
  try { leaf = hd.derive(path); } catch { return; }
  if (!leaf || !leaf.publicKey) return;
  const pkh = hash160(leaf.publicKey).toString("hex");
  if (KNOWN[pkh]) matches.push(`${path}  ->  ${addrOf(pkh)}   ${KNOWN[pkh]}`);
};

// 1) Structured BIP44 space for the two supported coin types.
for (const ct of [512, 0]) {
  for (let acct = 0; acct <= 5; acct++) {
    for (let chain = 0; chain <= 3; chain++) {
      for (let i = 0; i <= 50; i++) {
        check(`m/44'/${ct}'/${acct}'/${chain}/${i}`);
        check(`m/44'/${ct}'/${acct}/${chain}/${i}`); // non-hardened account
      }
    }
  }
}
// 2) Brute the coin type at the main (…/0/0) and swap (…/0/1) paths.
for (let ct = 0; ct <= 3000; ct++) {
  check(`m/44'/${ct}'/0'/0/0`);
  check(`m/44'/${ct}'/0'/0/1`);
  check(`m/44'/${ct}/0'/0/1`); // non-hardened coin type
}
// 3) A few non-standard prefixes some wallets have used.
for (let i = 0; i <= 20; i++) {
  for (const ct of [512, 0]) {
    check(`m/44'/${ct}'/0'/${i}`);
    check(`m/${ct}'/0'/0/${i}`);
    check(`m/0'/0'/0/${i}`);
    check(`m/0/0/${i}`);
  }
}
console.log(`(checked ${seen.size} derivations)\n`);
console.log("=== matched derivations (paths only — no secrets) ===");
if (matches.length) matches.forEach((m) => console.log("  " + m));
else console.log("  NONE of the known addresses matched.");
const foundNft = matches.some((m) => m.includes("NFT's swap"));
console.log(
  foundNft
    ? "\n>>> Found the NFT's swap path above — paste me that line. <<<"
    : "\n>>> The NFT's swap address (350e8568…) was NOT derivable from this seed in a\n" +
      "    wide search. That means it was created under a DIFFERENT seed/wallet, or a\n" +
      "    derivation no Photonic version used. Paste the full output and tell me if you\n" +
      "    ever used a different recovery phrase / wallet to list this NFT. <<<"
);
