import { Box, BoxProps, Text } from "@chakra-ui/react";
import { PropsWithChildren, ReactNode } from "react";

// Labelled metric tile (e.g. a balance). Value uses tabular-nums so digits
// don't jitter as the amount updates.
export default function MetricCard({
  label,
  children,
  ...rest
}: PropsWithChildren<{ label: ReactNode }> & BoxProps) {
  return (
    <Box
      bg="surface.raised"
      borderWidth="1px"
      borderColor="border.default"
      borderRadius="lg"
      px={5}
      py={4}
      {...rest}
    >
      <Text textStyle="label" mb={1}>
        {label}
      </Text>
      <Box textStyle="numeric" fontSize="2xl" fontWeight="semibold">
        {children}
      </Box>
    </Box>
  );
}
