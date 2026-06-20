import { Container, Text } from "@chakra-ui/react";
import Card from "@app/components/Card";

export default function Exit() {
  return (
    <Container maxW="container.sm" pt={32}>
      <Card alignItems="center" textAlign="center" gap={2}>
        <Text textStyle="body" color="text.secondary">
          {"Please close the window"}
        </Text>
      </Card>
    </Container>
  );
}
