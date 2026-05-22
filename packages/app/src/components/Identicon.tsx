import { Box, BoxProps } from "@chakra-ui/react";
import { useMemo } from "react";
import { toSvg } from "jdenticon";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

/**
 * Encode an SVG string as a base64 `data:image/svg+xml` URL.
 *
 * Rendering via `<img src=…>` runs the SVG in image context where the user
 * agent disables script execution and external references — even if
 * `jdenticon` (or any future SVG generator) emits a payload that would be
 * malicious under HTML context, it cannot run JavaScript here. This is
 * defense in depth on top of the page CSP.
 */
function svgToDataUrl(svg: string): string {
  // TextEncoder → byte array → binary string → base64 keeps us safe against
  // any non-ASCII characters a future SVG payload might contain.
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export default function Identicon({
  value,
  ...rest
}: { value: string } & BoxProps) {
  // Hash the ref to create more colour variation.
  // Memoize so we don't recompute the SVG (and base64) on every render.
  const dataUrl = useMemo(() => {
    const svg = toSvg(bytesToHex(sha256(value)), 100);
    return svgToDataUrl(svg);
  }, [value]);

  return (
    <Box display="flex" {...rest}>
      <img
        src={dataUrl}
        alt=""
        role="presentation"
        style={{ width: "100%", height: "100%" }}
      />
    </Box>
  );
}
