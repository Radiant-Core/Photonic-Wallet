import { Flex, FlexProps, Heading, Spacer } from "@chakra-ui/react";
import { PropsWithChildren, ReactNode } from "react";

// Standard in-page section title with an optional trailing action.
export default function SectionHeading({
  children,
  action,
  ...rest
}: PropsWithChildren<{ action?: ReactNode }> & FlexProps) {
  return (
    <Flex alignItems="center" gap={3} mb={3} {...rest}>
      <Heading textStyle="h3" color="whiteAlpha.900">
        {children}
      </Heading>
      {action && (
        <>
          <Spacer />
          {action}
        </>
      )}
    </Flex>
  );
}
