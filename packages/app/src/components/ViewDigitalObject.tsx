import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  BoxProps,
  Button,
  Container,
  Grid,
  GridItem,
  GridProps,
  Heading,
  HStack,
  Icon,
  IconButton,
  SimpleGrid,
  Tooltip,
  useClipboard,
  useDisclosure,
} from "@chakra-ui/react";
import { Trans, t } from "@lingui/macro";
import { useLiveQuery } from "dexie-react-hooks";
import { Link, useLocation, useNavigate } from "react-router-dom";
import db from "@app/db";
import {
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LinkIcon,
} from "@chakra-ui/icons";
import Outpoint from "@lib/Outpoint";
import Identifier from "@app/components/Identifier";
import SendDigitalObject from "@app/components/SendDigitalObject";
import { PropsWithChildren, ReactNode, useRef, useState } from "react";
import Card from "@app/components/Card";
import Photons from "@app/components/Photons";
import ContentContainer from "@app/components/ContentContainer";
import DownloadLink from "@app/components/DownloadLink";
import TokenContent from "@app/components/TokenContent";
import TokenType from "@app/components/TokenType";
import PageHeader from "@app/components/PageHeader";
import MeltDigitalObject from "./MeltDigitalObject";
import TxSuccessModal from "./TxSuccessModal";
import { SmartToken, TxO } from "../types";
import { openModal, wallet } from "@app/signals";
import TokenDetails from "./TokenDetails";
import createExplorerUrl from "@app/network/createExplorerUrl";
import { RiContractRightLine, RiExpandLeftLine } from "react-icons/ri";
import { useViewPanelContext } from "@app/layouts/ViewPanelLayout";
import ActionIcon from "./ActionIcon";
import { MdDeleteForever, MdEdit, MdLock, MdTimer } from "react-icons/md";
import { TbArrowUpRight, TbBox } from "react-icons/tb";
import mime from "mime";
import { GLYPH_ENCRYPTED, GLYPH_MUT, GLYPH_NFT, GLYPH_TIMELOCK } from "@lib/protocols";
import EditDigitalObject from "./EditDigitalObject";

export const PropertyCard = ({
  heading,
  info,
  children,
  ...rest
}: PropsWithChildren<
  { heading: React.ReactNode; info?: ReactNode } & BoxProps
>) => {
  return (
    <Card
      p={4}
      display="grid"
      gridTemplateAreas={`"heading info" "child child"`}
      gridTemplateColumns="auto 30px"
      {...rest}
    >
      <Heading
        size="sm"
        mb={2}
        color="lightBlue.A400"
        display="flex"
        flexDirection="row"
        alignItems="center"
      >
        {heading}
      </Heading>
      <Box>{info}</Box>
      {children}
    </Card>
  );
};

function Warning({ children }: PropsWithChildren) {
  return (
    <Alert status="warning" as={GridItem} justifyContent="center" colSpan={2}>
      <AlertIcon />
      {children}
    </Alert>
  );
}

export default function ViewDigitalObject({
  sref,
  context,
  ...rest
}: {
  sref: string;
  context?: string;
} & GridProps) {
  const [collapsed, setCollapsed] = useViewPanelContext();
  const size = collapsed ? "md" : "sm";
  const { search } = useLocation();
  const navigate = useNavigate();
  const sendDisclosure = useDisclosure();
  const meltDisclosure = useDisclosure();
  const editDisclosure = useDisclosure();
  const successDisclosure = useDisclosure();
  const [nft, txo, author, container] = useLiveQuery(
    async () => {
      const nft = await db.glyph.get({ ref: sref });
      if (!nft?.lastTxoId) return [undefined, undefined];
      const txo = await db.txo.get(nft.lastTxoId);
      const a = nft?.author && (await db.glyph.get({ ref: nft.author }));
      const c = nft?.container && (await db.glyph.get({ ref: nft.container }));
      return [nft, txo, a, c] as [SmartToken, TxO, SmartToken?, SmartToken?];
    },
    [sref],
    []
  );
  const txid = useRef("");
  const { onCopy: onLinkCopy } = useClipboard(nft?.remote?.u || "");

  // Decrypted bytes held in memory only — never written to any persistent storage
  const [decryptedBytes, setDecryptedBytes] = useState<Uint8Array | null>(null);
  const [decryptedMime, setDecryptedMime] = useState<string>("application/octet-stream");

  // TODO show loading or 404
  if (!txo || !nft) {
    return (
      <ContentContainer>
        <PageHeader />
      </ContentContainer>
    );
  }

  const unlock = (fn: () => void) => {
    if (wallet.value.locked) {
      openModal.value = {
        modal: "unlock",
        onClose: (success) => success && fn(),
      };
    } else {
      fn();
    }
  };

  const openSend = () => sendDisclosure.onOpen();
  const openEdit = () => editDisclosure.onOpen();
  const openMelt = () => meltDisclosure.onOpen();

  const openSuccess = (id: string) => {
    txid.current = id;
    successDisclosure.onOpen();
  };

  const isEncrypted = !!(nft.p?.includes(GLYPH_ENCRYPTED));
  const isTimelocked = !!(nft.p?.includes(GLYPH_TIMELOCK));
  const isMutable = !!(nft.p?.includes(GLYPH_NFT) && nft.p?.includes(GLYPH_MUT));
  const isIPFS = nft.remote?.u?.startsWith("ipfs://");
  const isKnownEmbed = [
    "text/plain",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
  ].includes(nft.embed?.t || "");
  const location = Outpoint.fromUTXO(txo.txid, txo.vout);
  const isLink = !!nft.location;

  return (
    <>
      <Grid gridTemplateRows="auto 1fr" height="100vh" {...rest}>
        <PageHeader
          close
          to={`${context}${search}`}
          toolbar={
            <IconButton
              display={{ base: "none", "2xl": "flex" }}
              isRound
              aria-label="Back"
              variant="ghost"
              icon={
                <Icon
                  as={collapsed ? RiContractRightLine : RiExpandLeftLine}
                  fontSize="2xl"
                />
              }
              onClick={() => setCollapsed(!collapsed)}
            />
          }
        >
          <HStack spacing={2} flexWrap="wrap" align="center">
            <span>{nft.name || "Unnamed token"}</span>
            {isEncrypted && !decryptedBytes && (
              <Tooltip label={isTimelocked ? "Timelocked encrypted content" : "Contains encrypted content"}>
                <Badge
                  colorScheme={isTimelocked ? "orange" : "blue"}
                  display="flex"
                  alignItems="center"
                  gap={1}
                  fontSize="xs"
                >
                  <Icon as={isTimelocked ? MdTimer : MdLock} />
                  {isTimelocked ? "Timelocked" : "Encrypted"}
                </Badge>
              </Tooltip>
            )}
            {isMutable && (
              <Tooltip label={"Token metadata can be modified by the owner"}>
                <Badge
                  colorScheme="purple"
                  display="flex"
                  alignItems="center"
                  gap={1}
                  fontSize="xs"
                >
                  <Icon as={MdEdit} />
                  {"Mutable"}
                </Badge>
              </Tooltip>
            )}
            {isEncrypted && decryptedBytes && (
              <Badge colorScheme="green" display="flex" alignItems="center" gap={1} fontSize="xs">
                <Icon as={MdLock} />
                {"Decrypted"}
              </Badge>
            )}
          </HStack>
        </PageHeader>
        <Container maxW="container.xl" overflowY="auto" pb={4}>
          <Grid
            columnGap={8}
            rowGap={4}
            templateColumns={
              size === "sm" ? "1fr" : { base: "1fr", xl: "2fr 3fr" }
            }
            alignItems="start"
          >
            <SimpleGrid columns={2} gap={2}>
              <GridItem
                p={4}
                minHeight="120px"
                alignItems="center"
                justifyContent="center"
                position="relative"
                as={Card}
                colSpan={2}
                sx={{
                  "& img": {
                    maxWidth: "400px",
                    maxHeight: "400px",
                  },
                }}
              >
                {isLink && (
                  <Box
                    position="absolute"
                    top={2}
                    right={2}
                    bgColor="blackAlpha.400"
                    p={2}
                    borderRadius={4}
                  >
                    <LinkIcon boxSize={8} />
                  </Box>
                )}
                <TokenContent
                  glyph={nft}
                  decryptedBytes={decryptedBytes}
                  decryptedMime={decryptedMime}
                  onDecrypted={(bytes, mime) => {
                    setDecryptedBytes(bytes);
                    setDecryptedMime(mime);
                  }}
                />
              </GridItem>
              {nft.embed && !isKnownEmbed && (
                <Warning>{"Files may be unsafe and result in loss of funds"}</Warning>
              )}
              {nft.swapPending && (
                <Alert
                  status="info"
                  as={GridItem}
                  justifyContent="center"
                  colSpan={2}
                >
                  <AlertIcon />
                  Swap pending
                </Alert>
              )}
              {!nft.embed && nft.remote && !isIPFS && (
                <Warning>
                  {"URLs may be unsafe and result in loss of funds"}
                </Warning>
              )}
              {isEncrypted && decryptedBytes && (
                <GridItem
                  as={DownloadLink}
                  data={decryptedBytes}
                  filename={`decrypted.${mime.getExtension(decryptedMime) || "dat"}`}
                  mimeType={decryptedMime}
                  leftIcon={<ActionIcon as={DownloadIcon} />}
                  colSpan={2}
                >
                  {"Download Decrypted File"}
                </GridItem>
              )}
              {nft.embed && (
                <GridItem
                  as={DownloadLink}
                  data={nft.embed.b}
                  filename={`main.${mime.getExtension(nft.embed.t) || "dat"}`}
                  mimeType={nft.embed.t || "application/octet-stream"}
                  leftIcon={<ActionIcon as={DownloadIcon} />}
                  colSpan={2}
                >
                  {"Download"}
                </GridItem>
              )}
              {!nft.embed && nft.remote && (
                <>
                  <GridItem
                    as={Button}
                    onClick={onLinkCopy}
                    leftIcon={<ActionIcon as={CopyIcon} />}
                    colSpan={2}
                  >
                    {"Copy URL"}
                  </GridItem>
                </>
              )}
              {isMutable && (
                <Button
                  leftIcon={<ActionIcon as={MdEdit} />}
                  onClick={() => unlock(openEdit)}
                  sx={{ gridColumn: "span 2 / span 2" }}
                >
                  {"Edit Token"}
                </Button>
              )}
              <Button
                disabled={nft.swapPending}
                leftIcon={<ActionIcon as={TbArrowUpRight} />}
                onClick={() => unlock(openSend)}
              >
                {"Send"}
              </Button>
              <Button
                disabled={nft.swapPending}
                leftIcon={<ActionIcon as={MdDeleteForever} />}
                onClick={() => unlock(openMelt)}
                _hover={{ bg: "red.600" }}
              >
                {"Melt"}
              </Button>
              {nft.type === "container" && (
                <Button
                  as={Link}
                  to={`/container/${nft.ref}`}
                  leftIcon={<ActionIcon as={TbBox} />}
                  sx={{ gridColumn: "span 2 / span 2" }}
                >
                  {"View contents"}
                </Button>
              )}
            </SimpleGrid>
            {nft && (
              <TokenDetails glyph={nft} container={container} author={author}>
                <PropertyCard heading={"Output value"}>
                  <Photons value={txo.value} />
                </PropertyCard>
                {nft.type && (
                  <PropertyCard heading={"Type"}>
                    <TokenType type={nft.type} />
                  </PropertyCard>
                )}
                <PropertyCard heading={"Location"}>
                  <div>
                    <Identifier showCopy copyValue={txo.txid}>
                      {location.shortOutput()}
                    </Identifier>
                    <IconButton
                      aria-label={"Open in block explorer"}
                      icon={<ExternalLinkIcon />}
                      size="xs"
                      variant="ghost"
                      as={Link}
                      to={createExplorerUrl(location.getTxid())}
                      target="_blank"
                    />
                  </div>
                </PropertyCard>
                {/* Temporarily disabled. See comment regarding date in buildUpdateTXOs.
                      <PropertyCard heading={"Received"}>
                        {txo.date
                          ? dayjs(txo.date * 1000).format("lll")
                          : "Unconfirmed"}
                      </PropertyCard>
                      */}
                <PropertyCard heading={"Height"}>
                  {txo.height === Infinity ? "Unconfirmed" : txo.height}
                </PropertyCard>
              </TokenDetails>
            )}
          </Grid>
        </Container>
      </Grid>
      <SendDigitalObject
        glyph={nft}
        txo={txo}
        disclosure={sendDisclosure}
        onSuccess={(txid) => {
          sendDisclosure.onClose();
          openSuccess(txid);
        }}
      />
      <EditDigitalObject
        token={nft}
        txo={txo}
        disclosure={editDisclosure}
        onSuccess={(txid) => {
          editDisclosure.onClose();
          openSuccess(txid);
        }}
      />
      <MeltDigitalObject
        asset={txo}
        disclosure={meltDisclosure}
        onSuccess={(txid: string) => {
          meltDisclosure.onClose();
          openSuccess(txid);
        }}
      />
      <TxSuccessModal
        onClose={() => {
          successDisclosure.onClose();
          navigate(context || "/objects");
        }}
        isOpen={successDisclosure.isOpen}
        txid={txid.current}
      />
    </>
  );
}
