import { Link } from "react-router-dom";
import { Box, Flex, FlexProps, Text } from "@chakra-ui/react";

// Single-orbit mark: a brand-gradient ring, a jewel-toned photon core, and a
// bright photon travelling on the ring (animated by the wrapper below).
// `svgId` prefixes the gradient ids so multiple instances on one page don't
// collide (SVG gradient ids are document-global).
const LogoSvg = ({ svgId, ...rest }: { svgId: string }) => {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" {...rest}>
      <defs>
        <linearGradient
          id={`${svgId}ring`}
          x1="0"
          y1="40"
          x2="40"
          y2="0"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#6200ea" />
          <stop offset="0.5" stopColor="#4a4eff" />
          <stop offset="1" stopColor="#00d4ff" />
        </linearGradient>
        <radialGradient id={`${svgId}core`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#cfe9ff" />
          <stop offset="0.5" stopColor="#4a4eff" />
          <stop offset="1" stopColor="#3400ca" />
        </radialGradient>
      </defs>
      <circle
        cx="20"
        cy="20"
        r="15"
        fill="none"
        stroke={`url(#${svgId}ring)`}
        strokeWidth="2.4"
        opacity="0.5"
      />
      <g className="photon">
        <circle cx="30.6" cy="9.4" r="5.4" fill="#37e0ff" opacity="0.18" />
        <circle cx="30.6" cy="9.4" r="3.3" fill="#3fe3ff" />
      </g>
      <circle cx="20" cy="20" r="5.4" fill={`url(#${svgId}core)`} />
    </svg>
  );
};

export default function Logo({
  svgId,
  responsive = true,
  text = "",
  ...rest
}: { svgId: string; responsive?: boolean; text?: string } & FlexProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = ({ lg, ...props }: any) => (responsive ? { ...props, lg } : props);

  return (
    <Flex
      alignItems="center"
      justifyContent="center"
      as={Link}
      to="/objects"
      flexDir={r({ base: "row", lg: "column" })}
      {...rest}
    >
      <Box
        width="8"
        height="8"
        mr={r({ base: "-28px", lg: 0 })}
        mb={r({ base: 0, lg: "-28px" })}
        backgroundColor="brand.500"
        borderRadius="50%"
        filter="blur(14px)"
        opacity={0.55}
      />
      <Box
        as={LogoSvg}
        svgId={svgId}
        w={6}
        h={6}
        zIndex={1}
        mr={r({ base: 1, lg: 0 })}
        sx={{
          // Photon completes one orbit of the ring on mount. The global
          // prefers-reduced-motion guard neutralises this automatically.
          "& .photon": {
            transformBox: "view-box",
            transformOrigin: "20px 20px",
            animation: { lg: "spin1 1.4s ease-out" },
          },
        }}
      />
      <Text
        as="div"
        fontFamily="Days One, sans-serif"
        fontSize="md"
        letterSpacing="0.06em"
        color="gray.100"
        textShadow="0 1px 2px rgba(0, 0, 0, 0.45)"
        userSelect="none"
        zIndex="10"
      >
        {text || "PHOTONIC"}
      </Text>
    </Flex>
  );
}
