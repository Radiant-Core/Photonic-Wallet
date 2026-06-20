import {
  Button,
  Container,
  Flex,
  SimpleGrid,
  Text,
  useBreakpointValue,
} from "@chakra-ui/react";
import PageHeader from "@app/components/PageHeader";
import Card from "@app/components/Card";
import ContentContainer from "@app/components/ContentContainer";
import { Navigate } from "react-router-dom";
import { network, openModal } from "@app/signals";
import Balance from "@app/components/Balance";
import { Box } from "@chakra-ui/react";

export default function MobileHome() {
  const mobile = useBreakpointValue({ base: true, lg: false });

  // Home page isn't needed on desktop, side bar has everything
  if (!mobile) {
    return <Navigate to="/objects" />;
  }

  return (
    <ContentContainer>
      <PageHeader showLogo />
      <Container maxW="container.md" px={4}>
        <Card mx="auto">
          <Flex flexDirection="column" alignItems="center" mb={6} gap={1}>
            <Text textStyle="label">{network.value.ticker} balance</Text>
            <Box
              textStyle="numeric"
              fontSize="3xl"
              fontWeight="bold"
              lineHeight={1.1}
            >
              <Balance />
            </Box>
          </Flex>
          <SimpleGrid columns={[1, 2]} spacing={4} alignSelf="stretch">
            <Button
              variant="primary"
              onClick={() => {
                openModal.value = { modal: "send" };
              }}
            >
              {"Send"}
            </Button>
            <Button
              onClick={() => {
                openModal.value = { modal: "receive" };
              }}
            >
              {"Receive"}
            </Button>
          </SimpleGrid>
        </Card>
      </Container>
    </ContentContainer>
  );
}
