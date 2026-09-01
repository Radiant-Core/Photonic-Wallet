/**
 * Reading an `OP_RETURN` data output well enough to show it.
 *
 * The approval screen used to render every unrecognised locking script as
 * "(non-standard output)". For a data carrier that is the least useful thing it
 * could say: the output carries 0 satoshis, so nothing about the *money* is
 * interesting, and the payload — the part that will be published permanently
 * and cannot be taken back — was the one thing not shown.
 *
 * This module describes such an output. It does not interpret it. Deciding that
 * some bytes are a timestamp, a token or a message is a claim about someone
 * else's protocol, and a wallet asserting it would be vouching for something it
 * cannot check. What it reports is structural: how big, how many pushes, and
 * which of those pushes happen to be readable text.
 */

const OP_RETURN = 0x6a;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;
const MAX_DIRECT_PUSH = 0x4b;

/** Refuse to describe an implausible payload rather than build a huge list. */
const MAX_PUSHES = 32;

export type DataPush = {
  /** The push contents, lowercase hex. Always present. */
  readonly hex: string;
  /**
   * The same bytes as text, when they decode as UTF-8 and contain nothing that
   * could hide or reorder what is rendered.
   *
   * Absent means "not safely displayable as text", never "empty".
   */
  readonly text?: string;
};

export type DataOutput = {
  /** Size of the whole scriptPubKey in bytes. */
  readonly size: number;
  /** Everything after the leading OP_RETURN, lowercase hex. */
  readonly payloadHex: string;
  /**
   * The payload split into pushes, when it is a clean sequence of them.
   *
   * Absent when the payload is not push-structured, which is legal and not an
   * error: the caller should fall back to showing `payloadHex`.
   */
  readonly pushes?: readonly DataPush[];
};

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Characters that can hide or reorder rendered text, plus C0/C1 controls.
 *
 * Kept in step with `sanitizeForDisplay` in ./displayText. Here it decides
 * whether text is offered at all; there it is the second line of defence at the
 * point of rendering.
 */
const UNSAFE_TEXT_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B\u200E-\u200F\u2028-\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/u;

const utf8 = new TextDecoder("utf-8", { fatal: true });

function readableText(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return undefined;
  }
  if (UNSAFE_TEXT_RE.test(text)) return undefined;
  return text;
}

/** Read the pushes in `payload`, or undefined if it is not a push sequence. */
function readPushes(payload: Uint8Array): DataPush[] | undefined {
  const pushes: DataPush[] = [];
  let i = 0;

  while (i < payload.length) {
    if (pushes.length >= MAX_PUSHES) return undefined;

    const opcode = payload[i];
    if (opcode === undefined) return undefined;
    i += 1;

    let length: number;
    if (opcode >= 0x01 && opcode <= MAX_DIRECT_PUSH) {
      length = opcode;
    } else if (opcode === OP_PUSHDATA1) {
      if (i + 1 > payload.length) return undefined;
      length = payload[i]!;
      i += 1;
    } else if (opcode === OP_PUSHDATA2) {
      if (i + 2 > payload.length) return undefined;
      length = payload[i]! | (payload[i + 1]! << 8);
      i += 2;
    } else if (opcode === OP_PUSHDATA4) {
      if (i + 4 > payload.length) return undefined;
      length =
        payload[i]! +
        payload[i + 1]! * 0x100 +
        payload[i + 2]! * 0x10000 +
        payload[i + 3]! * 0x1000000;
      i += 4;
    } else {
      // A non-push opcode. Legal in a data output, but not something this
      // module claims to describe - the caller shows raw hex instead.
      return undefined;
    }

    if (i + length > payload.length) return undefined;
    const bytes = payload.subarray(i, i + length);
    i += length;

    const text = readableText(bytes);
    pushes.push({
      hex: bytesToHex(bytes),
      ...(text === undefined ? {} : { text }),
    });
  }

  return pushes;
}

/**
 * Describe a locking script if it is a data output, or undefined if it is not.
 *
 * Never throws: this runs on a script an app supplied, on the screen where the
 * user decides whether to trust that app.
 */
export function readDataOutput(scriptHex: string): DataOutput | undefined {
  const script = hexToBytes(scriptHex);
  if (!script || script.length === 0 || script[0] !== OP_RETURN) {
    return undefined;
  }

  const payload = script.subarray(1);
  const pushes = readPushes(payload);

  return {
    size: script.length,
    payloadHex: bytesToHex(payload),
    ...(pushes === undefined ? {} : { pushes }),
  };
}
