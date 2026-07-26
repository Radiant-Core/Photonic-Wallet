/**
 * Low-level byte plumbing for the PSBT container: a bounds-checked reader,
 * a growable writer, Bitcoin CompactSize varints, and the BIP-174
 * key-value-map framing (`varint keylen ‖ keytype ‖ keydata` /
 * `varint valuelen ‖ value`, maps terminated by a single 0x00 byte).
 *
 * Matches Radiant Core's deserializer strictness: varints must be minimally
 * encoded (Core's `ReadCompactSize` rejects non-canonical forms) and a
 * duplicate full key within one map is a hard error (BIP-174 requirement,
 * enforced by Core's `SerializeToVector` reader).
 */
import { bytesToHex } from "@noble/hashes/utils";
import { PsbtError } from "./errors";

/** One raw key-value entry: `keyType` varint + remaining key bytes + value. */
export type PsbtKeyValue = {
  keyType: number;
  keyData: Uint8Array;
  value: Uint8Array;
};

export class ByteReader {
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.pos;
  }

  eof(): boolean {
    return this.pos >= this.bytes.length;
  }

  readBytes(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.bytes.length) {
      throw new PsbtError("TRUNCATED", "unexpected end of data");
    }
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  readUInt8(): number {
    return this.readBytes(1)[0];
  }

  readUInt32LE(): number {
    const b = this.readBytes(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  readUInt64LE(): bigint {
    const b = this.readBytes(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) {
      v = (v << 8n) | BigInt(b[i]);
    }
    return v;
  }

  /** Bitcoin CompactSize varint; rejects non-canonical encodings like Core. */
  readVarInt(): number {
    const first = this.readUInt8();
    let v: bigint;
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const b = this.readBytes(2);
      v = BigInt(b[0] | (b[1] << 8));
      if (v < 0xfdn) throw new PsbtError("NON_CANONICAL_VARINT");
    } else if (first === 0xfe) {
      v = BigInt(this.readUInt32LE());
      if (v < 0x10000n) throw new PsbtError("NON_CANONICAL_VARINT");
    } else {
      v = this.readUInt64LE();
      if (v < 0x100000000n) throw new PsbtError("NON_CANONICAL_VARINT");
    }
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PsbtError("TRUNCATED", "varint length is absurdly large");
    }
    return Number(v);
  }

  /** varint length followed by that many bytes. */
  readVarSlice(): Uint8Array {
    return this.readBytes(this.readVarInt());
  }
}

export class ByteWriter {
  private chunks: Uint8Array[] = [];

  writeBytes(b: Uint8Array): void {
    this.chunks.push(b);
  }

  writeUInt8(v: number): void {
    this.chunks.push(Uint8Array.of(v & 0xff));
  }

  writeUInt32LE(v: number): void {
    this.chunks.push(
      Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
    );
  }

  writeUInt64LE(v: bigint): void {
    const b = new Uint8Array(8);
    let x = v;
    for (let i = 0; i < 8; i++) {
      b[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    this.chunks.push(b);
  }

  writeVarInt(v: number): void {
    if (v < 0xfd) {
      this.writeUInt8(v);
    } else if (v <= 0xffff) {
      this.writeUInt8(0xfd);
      this.chunks.push(Uint8Array.of(v & 0xff, (v >>> 8) & 0xff));
    } else if (v <= 0xffffffff) {
      this.writeUInt8(0xfe);
      this.writeUInt32LE(v);
    } else {
      this.writeUInt8(0xff);
      this.writeUInt64LE(BigInt(v));
    }
  }

  writeVarSlice(b: Uint8Array): void {
    this.writeVarInt(b.length);
    this.writeBytes(b);
  }

  toBytes(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of this.chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }
}

/**
 * Read one key-value map: entries until the 0x00 separator (an empty key).
 * A repeated full key (type + keydata) within the map is a hard reject.
 */
export function readKeyValueMap(reader: ByteReader): PsbtKeyValue[] {
  const entries: PsbtKeyValue[] = [];
  const seen = new Set<string>();
  for (;;) {
    const keyLen = reader.readVarInt();
    if (keyLen === 0) return entries; // separator
    const key = reader.readBytes(keyLen);
    const keyReader = new ByteReader(key);
    const keyType = keyReader.readVarInt();
    const keyData = key.subarray(keyReader.offset);
    const value = reader.readVarSlice();
    const dupKey = bytesToHex(key);
    if (seen.has(dupKey)) {
      throw new PsbtError("DUPLICATE_KEY", `duplicate key in map: ${dupKey}`);
    }
    seen.add(dupKey);
    entries.push({ keyType, keyData, value });
  }
}

/** Serialize one entry. Key types in this profile all fit a single byte. */
export function writeKeyValue(writer: ByteWriter, kv: PsbtKeyValue): void {
  const keyWriter = new ByteWriter();
  keyWriter.writeVarInt(kv.keyType);
  keyWriter.writeBytes(kv.keyData);
  writer.writeVarSlice(keyWriter.toBytes());
  writer.writeVarSlice(kv.value);
}

export function writeKeyValueMap(
  writer: ByteWriter,
  entries: PsbtKeyValue[]
): void {
  for (const kv of entries) writeKeyValue(writer, kv);
  writer.writeUInt8(0x00); // separator
}
