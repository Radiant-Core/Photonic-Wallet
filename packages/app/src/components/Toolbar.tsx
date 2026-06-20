import { HStack, StackProps } from "@chakra-ui/react";
import { PropsWithChildren } from "react";

// Standardised right-aligned action cluster for page headers and layout
// toolbars, so action spacing is consistent across screens.
export default function Toolbar({
  children,
  ...rest
}: PropsWithChildren & StackProps) {
  return (
    <HStack spacing={2} {...rest}>
      {children}
    </HStack>
  );
}
