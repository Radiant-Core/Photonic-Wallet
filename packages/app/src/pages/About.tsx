import { Container, Heading, Text } from "@chakra-ui/react";
import License from "@app/components/License";
import Card from "@app/components/Card";
import DataRow from "@app/components/DataRow";

export default function About() {
  return (
    <Container maxW="container.lg" display="grid" gap={6}>
      <Card gap={1}>
        <DataRow label="Application">
          <Text textStyle="body">Photonic Wallet</Text>
        </DataRow>
        <DataRow label="Version">
          <Text textStyle="body" sx={{ fontVariantNumeric: "tabular-nums" }}>
            {APP_VERSION}
          </Text>
        </DataRow>
      </Card>
      <Card gap={4}>
        <Heading textStyle="h3">{"License"}</Heading>
        <License />
      </Card>
    </Container>
  );
}
