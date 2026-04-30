import { Button, Image } from "@chakra-ui/react";
import Identifier from "./Identifier";
import { useState } from "react";

const ALLOWED_SCHEMES = ["https:", "ipfs:"];

function isSafeImageUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return ALLOWED_SCHEMES.includes(protocol);
  } catch {
    return false;
  }
}

export default function UnsafeImage({ src }: { src: string }) {
  const [show, setShow] = useState(false);
  const safe = isSafeImageUrl(src);

  if (show && safe) {
    return (
      <Image
        src={src}
        width="100%"
        height="100%"
        objectFit="contain"
        backgroundColor="black"
      />
    );
  }
  return (
    <>
      <Identifier>{src}</Identifier>
      {safe ? (
        <Button mt={4} onClick={() => setShow(true)}>
          Show image
        </Button>
      ) : (
        <Button mt={4} isDisabled title="URL scheme not allowed (only https and ipfs are permitted)">
          Show image
        </Button>
      )}
    </>
  );
}
