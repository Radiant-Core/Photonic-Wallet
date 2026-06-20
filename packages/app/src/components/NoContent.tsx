import { Flex, Icon, Text } from "@chakra-ui/react";
import { PropsWithChildren, ReactNode } from "react";
import { IconType } from "react-icons/lib";

// Empty-state placeholder. `children` is the title (kept as the original
// signature so existing call sites need no change); `icon`, `subtitle` and
// `action` are optional enhancements.
export default function NoContent({
  children,
  icon,
  subtitle,
  action,
}: PropsWithChildren<{
  icon?: IconType;
  subtitle?: ReactNode;
  action?: ReactNode;
}>) {
  return (
    <Flex
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      pt="18vh"
      px={6}
      gap={3}
      textAlign="center"
    >
      {icon && <Icon as={icon} boxSize={12} color="whiteAlpha.300" />}
      <Text textStyle="h2" color="whiteAlpha.800">
        {children}
      </Text>
      {subtitle && (
        <Text textStyle="small" maxW="sm">
          {subtitle}
        </Text>
      )}
      {action}
    </Flex>
  );
}
