import React, { useState } from "react";
import {
  VStack,
  Accordion,
  AccordionItem,
  AccordionButton,
  AccordionPanel,
  AccordionIcon,
  Box,
  Text,
  FormControl,
  FormLabel,
  Input,
  Textarea,
  Switch,
  Badge,
} from "@chakra-ui/react";
import { Trans, t } from "@lingui/macro";
import RoyaltyConfig from "./RoyaltyConfig";
import PolicyConfig from "./PolicyConfig";
import { GlyphV2Royalty, GlyphV2Policy } from "@lib/v2metadata";

type MintV2FieldsProps = {
  onRoyaltyChange: (royalty: GlyphV2Royalty | undefined) => void;
  onPolicyChange: (policy: GlyphV2Policy) => void;
  onRightsChange: (rights: { license?: string; terms?: string; attribution?: string }) => void;
  onCreatorSignChange: (enabled: boolean) => void;
};

export default function MintV2Fields({
  onRoyaltyChange,
  onPolicyChange,
  onRightsChange,
  onCreatorSignChange,
}: MintV2FieldsProps) {
  const [license, setLicense] = useState("");
  const [terms, setTerms] = useState("");
  const [attribution, setAttribution] = useState("");
  const [creatorSign, setCreatorSign] = useState(false);

  const handleRightsUpdate = () => {
    onRightsChange({
      license: license || undefined,
      terms: terms || undefined,
      attribution: attribution || undefined,
    });
  };

  React.useEffect(() => {
    handleRightsUpdate();
  }, [license, terms, attribution]);

  React.useEffect(() => {
    onCreatorSignChange(creatorSign);
  }, [creatorSign]);

  return (
    <Accordion allowMultiple>
      <AccordionItem>
        <AccordionButton>
          <Box flex="1" textAlign="left">
            <Text fontWeight="bold">
              Royalty Settings
            </Text>
            <Text fontSize="sm" color="gray.400">
              Configure on-chain or advisory royalties
            </Text>
          </Box>
          <Badge colorScheme="purple" mr={2}>
            v2
          </Badge>
          <AccordionIcon />
        </AccordionButton>
        <AccordionPanel pb={4}>
          <RoyaltyConfig onChange={onRoyaltyChange} />
        </AccordionPanel>
      </AccordionItem>

      <AccordionItem>
        <AccordionButton>
          <Box flex="1" textAlign="left">
            <Text fontWeight="bold">
              Policy Settings
            </Text>
            <Text fontSize="sm" color="gray.400">
              Renderable, transferable, NSFW flags
            </Text>
          </Box>
          <Badge colorScheme="purple" mr={2}>
            v2
          </Badge>
          <AccordionIcon />
        </AccordionButton>
        <AccordionPanel pb={4}>
          <PolicyConfig onChange={onPolicyChange} />
        </AccordionPanel>
      </AccordionItem>

      <AccordionItem>
        <AccordionButton>
          <Box flex="1" textAlign="left">
            <Text fontWeight="bold">
              Rights & Licensing
            </Text>
            <Text fontSize="sm" color="gray.400">
              License, terms, and attribution
            </Text>
          </Box>
          <Badge colorScheme="purple" mr={2}>
            v2
          </Badge>
          <AccordionIcon />
        </AccordionButton>
        <AccordionPanel pb={4}>
          <VStack spacing={4} align="stretch">
            <FormControl>
              <FormLabel>
                License
              </FormLabel>
              <Input
                value={license}
                onChange={(e) => setLicense(e.target.value)}
                placeholder={"CC BY 4.0, MIT, etc."}
              />
            </FormControl>

            <FormControl>
              <FormLabel>
                Terms
              </FormLabel>
              <Textarea
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                placeholder={"Usage terms and conditions"}
                rows={3}
              />
            </FormControl>

            <FormControl>
              <FormLabel>
                Attribution
              </FormLabel>
              <Input
                value={attribution}
                onChange={(e) => setAttribution(e.target.value)}
                placeholder={"How to credit the creator"}
              />
            </FormControl>
          </VStack>
        </AccordionPanel>
      </AccordionItem>

      <AccordionItem>
        <AccordionButton>
          <Box flex="1" textAlign="left">
            <Text fontWeight="bold">
              Creator Signature
            </Text>
            <Text fontSize="sm" color="gray.400">
              Cryptographically sign this token
            </Text>
          </Box>
          <Badge colorScheme="purple" mr={2}>
            v2
          </Badge>
          <AccordionIcon />
        </AccordionButton>
        <AccordionPanel pb={4}>
          <FormControl display="flex" alignItems="center">
            <FormLabel mb={0} flex={1}>
              Sign with wallet key
            </FormLabel>
            <Switch
              isChecked={creatorSign}
              onChange={(e) => setCreatorSign(e.target.checked)}
            />
          </FormControl>
          <Text fontSize="sm" color="gray.400" mt={2}>
            Adds a cryptographic signature proving you created this token.
            This provides verifiable provenance.
          </Text>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}
