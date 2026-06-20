import {
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  ModalCloseButton,
  Text,
  Flex,
  ModalProps,
  Link,
} from "@chakra-ui/react";
import Identifier from "./Identifier";
import { Link as RouterLink } from "react-router-dom";
import { ExternalLinkIcon } from "@chakra-ui/icons";
import createExplorerUrl from "@app/network/createExplorerUrl";

export default function MintSuccessModal({
  returnTo,
  isOpen,
  onClose,
  txid,
}: Pick<ModalProps, "isOpen" | "onClose"> & {
  returnTo: string;
  txid: string;
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      closeOnOverlayClick={false}
      isCentered
      size="lg"
    >
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>{"Mint successful"}</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <Text mb={2} textStyle="label">
            {"Transaction ID:"}
          </Text>
          <div>
            <Identifier showCopy>{txid}</Identifier>
          </div>
          <Link
            as={RouterLink}
            to={createExplorerUrl(txid)}
            target="_blank"
            isExternal
            color="accent.secondary"
            display="inline-flex"
            alignItems="center"
            my={4}
          >
            {"View on block explorer"}
            <ExternalLinkIcon mx="2px" />
          </Link>
        </ModalBody>

        <ModalFooter as={Flex} gap={4}>
          <Button variant="primary" onClick={onClose}>
            {"Mint another"}
          </Button>
          <Button as={RouterLink} to={returnTo}>
            {"Back to wallet"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
