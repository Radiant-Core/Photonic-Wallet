import { Box, BoxProps, forwardRef } from "@chakra-ui/react";
import { PropsWithChildren } from "react";

export default forwardRef<BoxProps, "div">(function Card(
  { children, ...rest }: PropsWithChildren,
  ref
) {
  return (
    <Box
      display="flex"
      flexDirection="column"
      backgroundColor="surface.raised"
      borderWidth="1px"
      borderColor="border.default"
      boxShadow="md"
      borderRadius="xl"
      p={{ base: 5, lg: 8 }}
      ref={ref}
      {...rest}
    >
      {children}
    </Box>
  );
});
