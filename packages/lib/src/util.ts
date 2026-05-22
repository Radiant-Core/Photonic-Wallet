import { bytesToHex, randomBytes } from "@noble/hashes/utils";

export function jsonHex(obj: unknown, byteLimit = 0) {
  const tooLarge = "<data too large>";
  return JSON.stringify(
    obj,
    (_, value) => {
      if (value instanceof Uint8Array) {
        if (byteLimit && value.length > byteLimit) return tooLarge;
        return bytesToHex(value);
      }
      // JSON.stringify converts Buffer to { type: "Buffer", data: [] } so convert back to Buffer then to hex
      if (value?.type === "Buffer") {
        const buf = Buffer.from(value);
        if (byteLimit && buf.length > byteLimit) return tooLarge;
        return bytesToHex(buf);
      }
      if (typeof value === "string") {
        if (byteLimit && value.length / 2 > byteLimit) return tooLarge;
      }

      return value;
    },
    2
  );
}

export function arrayChunks<T = unknown>(arr: T[], chunkSize: number) {
  const chunks = [];

  for (let i = 0; i < arr.length; i += chunkSize) {
    const chunk = arr.slice(i, i + chunkSize);
    chunks.push(chunk);
  }

  return chunks;
}

export async function batchRequests<ParamType, ValueType>(
  params: ParamType[],
  batchSize: number,
  callback: (param: ParamType) => Promise<[string, ValueType | undefined]>
) {
  const paramBatches = arrayChunks(Array.from(params), batchSize);
  const responseBatches = [];
  console.debug(`Fetching ${paramBatches.length} batches`);

  for (const paramBatch of paramBatches) {
    console.debug(`Fetching batch ${new Date().getTime()}`);
    // Serialize to avoid Safari IndexedDB "out of memory" from concurrent transactions
    const batchResults: [string, ValueType | undefined][] = [];
    for (const param of paramBatch) {
      batchResults.push(await callback(param));
    }
    responseBatches.push(batchResults);
  }
  return Object.fromEntries(responseBatches.flat().filter(([, v]) => v)) as {
    [key: string]: ValueType;
  };
}

/**
 * Draw a uniform random integer in [0, max) using a CSPRNG with rejection
 * sampling to avoid modulo bias.
 *
 * `crypto.getRandomValues` produces uniform uint32s; taking `r % max`
 * directly would over-represent the low bins whenever `max` does not
 * divide 2^32. We reject any draw at or above the largest multiple of
 * `max` that fits in uint32, then take the modulus of the survivor.
 *
 * Exported so callers can also share it (e.g. for sampling indices into
 * other structures).
 */
export function unbiasedRandomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error(
      `unbiasedRandomInt: max must be a positive integer; got ${max}`
    );
  }
  if (max === 1) return 0;
  const RANGE = 0x1_0000_0000; // 2^32
  const limit = RANGE - (RANGE % max);
  // randomBytes returns CSPRNG bytes (window.crypto in browsers, crypto in Node).
  // Loop is statistically bounded — expected iterations < 2.
  for (;;) {
    const buf = randomBytes(4);
    const r =
      (buf[0] * 0x1000000 + ((buf[1] << 16) | (buf[2] << 8) | buf[3])) >>> 0;
    if (r < limit) return r % max;
  }
}

/**
 * In-place Fisher–Yates shuffle using a CSPRNG.
 *
 * Replaces a `Math.random()`-based implementation. The previous version was
 * predictable enough that a network adversary observing timing could bias
 * ElectrumX server selection toward a controlled endpoint.
 *
 * Generic so callers retain their element type without an explicit cast.
 */
export function shuffle<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = unbiasedRandomInt(i + 1);
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
  return array;
}
