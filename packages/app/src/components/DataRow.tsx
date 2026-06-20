import { Box, Flex, FlexProps, Text } from "@chakra-ui/react";
import { PropsWithChildren, ReactNode } from "react";

// Label/value detail row used across token, swap, vault and about panels.
// Hairline separator between rows; the last row drops its border.
export default function DataRow({
  label,
  children,
  ...rest
}: PropsWithChildren<{ label: ReactNode }> & FlexProps) {
  return (
    <Flex
      justifyContent="space-between"
      alignItems="baseline"
      gap={4}
      py={2}
      borderBottomWidth="1px"
      borderColor="border.subtle"
      _last={{ borderBottomWidth: 0 }}
      {...rest}
    >
      <Text textStyle="small" flexShrink={0}>
        {label}
      </Text>
      <Box textAlign="right" minW={0} overflow="hidden">
        {children}
      </Box>
    </Flex>
  );
}
