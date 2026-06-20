import Logo from "@app/components/Logo";
import { Box, Flex } from "@chakra-ui/react";
import { Outlet } from "react-router-dom";

export default function SetupLayout() {
  return (
    <>
      {/* Soft brand wash across the top — the single sanctioned gradient
          "hero" moment on the onboarding screens. Sits behind all content. */}
      <Box
        position="fixed"
        top="0"
        left="0"
        right="0"
        height="360px"
        bgImage="var(--gradient-brand-soft)"
        opacity={0.55}
        pointerEvents="none"
        zIndex={-1}
      />
      <Flex
        position="fixed"
        alignItems="center"
        alignSelf="stretch"
        pl={4}
        height={{ base: "60px", lg: "72px" }}
        top="0"
        left="0"
        right="0"
        bgColor="rgba(26, 26, 36, 0.55)"
        backdropFilter="blur(12px)"
        borderBottomWidth="1px"
        borderBottomColor="border.subtle"
        mb={4}
        zIndex={10}
      >
        <Logo svgId="m" responsive={false} />
      </Flex>
      <Outlet />
    </>
  );
}
