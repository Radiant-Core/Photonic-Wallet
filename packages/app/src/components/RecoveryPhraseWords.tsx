import { Box, Flex, Tag, SimpleGrid } from "@chakra-ui/react";
import { PropsWithChildren } from "react";

function Word({ n, children }: PropsWithChildren<{ n: number }>) {
  return (
    <Flex
      bg="surface.sunken"
      borderWidth="1px"
      borderColor="border.subtle"
      p={2}
      borderRadius="md"
      alignItems="center"
    >
      <Box mr={2} userSelect="none">
        <Tag
          width={8}
          justifyContent="center"
          bg="whiteAlpha.100"
          color="whiteAlpha.700"
        >
          {n + 1}
        </Tag>
      </Box>
      <Box flexGrow={1} textAlign="center" fontFamily="mono" fontWeight="medium">
        {children}
      </Box>
    </Flex>
  );
}

export default function RecoveryPhraseWords({ words }: { words: string[] }) {
  return (
    <SimpleGrid columns={[2, 2, 3]} spacing={2} mb={4}>
      {words.map((word, index) => (
        <Word n={index} key={index}>
          {word}
        </Word>
      ))}
    </SimpleGrid>
  );
}
