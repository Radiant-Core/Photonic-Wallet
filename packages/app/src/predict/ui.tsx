/**
 * Shared neon UI primitives for the prediction-market pages — the dark glass "hero" card,
 * the RadiantSwap brand badge, the green/red split probability bar, the neon buy buttons,
 * and the categorical outcome chips. Kept in one place so the binary, categorical and list
 * pages share exactly one visual language.
 */
import { ReactNode } from "react";
import {
  Box,
  BoxProps,
  Button,
  ButtonProps,
  Flex,
  Heading,
  Text,
} from "@chakra-ui/react";

/** Neon palette — bright mint for YES, hot coral for NO, against a near-black teal glass. */
export const NEON = {
  yes: "#3fe6a4",
  yesText: "#5ef0b0",
  no: "#ff6585",
  noText: "#ff7d97",
  border: "rgba(74, 222, 168, 0.22)",
};

/** The glowing RADIANTSWAP · BETA pill. */
export function BrandBadge(props: BoxProps) {
  return (
    <Flex
      align="center"
      gap={2}
      flexShrink={0}
      fontFamily="mono"
      fontSize="xs"
      fontWeight="semibold"
      letterSpacing="0.18em"
      px={3}
      py={1.5}
      borderRadius="full"
      border="1px solid"
      borderColor="rgba(120, 220, 180, 0.32)"
      bg="rgba(16, 38, 32, 0.5)"
      textShadow="0 0 12px rgba(74, 222, 168, 0.5)"
      {...props}
    >
      <Text as="span" color={NEON.yesText}>
        RADIANTSWAP
      </Text>
      <Text as="span" color="whiteAlpha.500">
        ·
      </Text>
      <Text as="span" color="whiteAlpha.800">
        BETA
      </Text>
    </Flex>
  );
}

/** Dark glass card container with the green-glow border. Accepts BoxProps to tune size/spacing. */
export function HeroCard({ children, ...rest }: BoxProps) {
  return (
    <Box
      position="relative"
      overflow="hidden"
      borderRadius="2xl"
      border="1px solid"
      borderColor={NEON.border}
      bg="radial-gradient(120% 120% at 50% 0%, rgba(40, 110, 92, 0.14), transparent 55%), linear-gradient(160deg, #0d1b18 0%, #0a1117 60%, #0a0f14 100%)"
      boxShadow="inset 0 0 0 1px rgba(74, 222, 168, 0.05), 0 0 60px rgba(36, 200, 148, 0.06), 0 24px 60px rgba(0, 0, 0, 0.55)"
      {...rest}
    >
      {children}
    </Box>
  );
}

/** Full-width hero card with the question top-left and the brand badge top-right. */
export function MarketHeroFrame({
  question,
  headerMb = 6,
  children,
  ...rest
}: {
  question: ReactNode;
  headerMb?: BoxProps["mb"];
  children?: ReactNode;
} & BoxProps) {
  return (
    <HeroCard
      maxW="3xl"
      px={{ base: 5, md: 8 }}
      py={{ base: 5, md: 7 }}
      {...rest}
    >
      <Flex
        justify="space-between"
        align="flex-start"
        gap={4}
        wrap="wrap"
        mb={headerMb}
      >
        <Heading
          size={{ base: "md", md: "lg" }}
          lineHeight="1.15"
          maxW={{ md: "60%" }}
          color="whiteAlpha.900"
          fontWeight="bold"
        >
          {question}
        </Heading>
        <BrandBadge />
      </Flex>
      {children}
    </HeroCard>
  );
}

/** Green/red split bar. `yesPct` is 0–100; both sides always stay visible. */
export function NeonSplitBar({
  yesPct,
  h = "14px",
  ...rest
}: { yesPct: number; h?: BoxProps["h"] } & BoxProps) {
  const w = Math.max(2, Math.min(98, yesPct));
  return (
    <Flex h={h} align="stretch" {...rest}>
      <Box
        w={`${w}%`}
        borderRadius="full"
        bg="linear-gradient(90deg, #22c98a, #46e6a0)"
        boxShadow="0 0 16px rgba(70, 230, 160, 0.55)"
      />
      <Box w="4px" flexShrink={0} />
      <Box
        flex="1"
        borderRadius="full"
        bg="linear-gradient(90deg, #f2547a, #ff7a93)"
        boxShadow="0 0 16px rgba(255, 90, 120, 0.5)"
      />
    </Flex>
  );
}

/** Neon-outline buy button — green for YES, coral for NO. Forwards all Button props (isLoading,
 *  isDisabled, onClick…). */
export function NeonBuyButton({
  side,
  children,
  ...rest
}: { side: "yes" | "no" } & ButtonProps) {
  const yes = side === "yes";
  const fill = yes ? "rgba(43, 213, 138, 0.07)" : "rgba(242, 84, 122, 0.07)";
  const fillHover = yes
    ? "rgba(43, 213, 138, 0.16)"
    : "rgba(242, 84, 122, 0.16)";
  const glow = yes
    ? "0 0 24px rgba(70, 230, 160, 0.4)"
    : "0 0 24px rgba(255, 90, 120, 0.4)";
  return (
    <Button
      flex="1"
      minW="40"
      h="52px"
      fontFamily="mono"
      fontWeight="bold"
      letterSpacing="0.1em"
      color={yes ? NEON.yesText : NEON.noText}
      bg={fill}
      border="1.5px solid"
      borderColor={yes ? "rgba(70, 230, 160, 0.55)" : "rgba(255, 90, 120, 0.5)"}
      _hover={{ bg: fillHover, boxShadow: glow, transform: "translateY(-1px)" }}
      _active={{ transform: "translateY(0)" }}
      _disabled={{
        opacity: 0.4,
        cursor: "not-allowed",
        _hover: { bg: fill, boxShadow: "none", transform: "none" },
      }}
      {...rest}
    >
      {children}
    </Button>
  );
}

/** Outcome pills for categorical/scalar markets (no order book → no odds, so we show the slate
 *  of outcomes instead). `winner` is the 1-based resolved outcome, or 0 while open/unresolved. */
export function OutcomeChips({
  labels,
  winner = 0,
  max = 12,
}: {
  labels: string[];
  winner?: number;
  max?: number;
}) {
  const shown = labels.slice(0, max);
  const extra = labels.length - shown.length;
  return (
    <Flex gap={2} wrap="wrap">
      {shown.map((label, i) => {
        const won = winner === i + 1;
        return (
          <Box
            key={i}
            px={3}
            py={1.5}
            borderRadius="lg"
            fontSize="sm"
            fontFamily="mono"
            border="1px solid"
            color={won ? "#0a120f" : "whiteAlpha.800"}
            borderColor={
              won ? "rgba(70, 230, 160, 0.9)" : "rgba(120, 220, 180, 0.25)"
            }
            bg={
              won
                ? "linear-gradient(90deg, #22c98a, #46e6a0)"
                : "rgba(16, 38, 32, 0.45)"
            }
            fontWeight={won ? "bold" : "normal"}
            boxShadow={won ? "0 0 18px rgba(70, 230, 160, 0.5)" : "none"}
          >
            {label || `outcome ${i + 1}`}
          </Box>
        );
      })}
      {extra > 0 && (
        <Box
          px={3}
          py={1.5}
          fontSize="sm"
          fontFamily="mono"
          color="whiteAlpha.500"
        >
          +{extra} more
        </Box>
      )}
    </Flex>
  );
}
