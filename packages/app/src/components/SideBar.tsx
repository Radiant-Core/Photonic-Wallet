import {
  Box,
  CloseButton,
  Flex,
  Grid,
  GridProps,
  Icon,
  SimpleGrid,
} from "@chakra-ui/react";
import AccountBar from "./AccountBar";
import Logo from "./Logo";
import StatusBar from "./StatusBar";
import { language, openMenu } from "@app/signals";
import { RiSwap2Line } from "react-icons/ri";
import { HiOutlineAtSymbol } from "react-icons/hi";
import { MdHome, MdStorefront, MdLink } from "react-icons/md";
import {
  TbTriangleSquareCircle,
  TbHistory,
  TbStack2,
  TbLock,
  TbChartLine,
} from "react-icons/tb";
import MenuButton from "./MenuButton";
import SyncBar from "./SyncBar";

export default function SideBar({ ...rest }: GridProps) {
  // Trigger rerender when language changes
  void language.value;

  return (
    <Grid
      width={{ base: "75%", lg: "232px", "2xl": "284px" }}
      height="100svh"
      bgColor="bg.300"
      borderRightWidth={{ lg: "1px" }}
      borderRightColor="border.subtle"
      gridTemplateRows={{
        base: "72px auto auto 1fr",
        lg: "auto auto auto 1fr",
      }}
      zIndex={20}
      {...rest}
    >
      <Flex
        alignItems="center"
        justifyContent="space-between"
        px={6}
        display={{ base: "flex", lg: "none" }}
      >
        <CloseButton
          display="none"
          size="lg"
          onClick={() => {
            openMenu.value = false;
          }}
          aria-label="Close menu"
        />
        <Logo
          my={6}
          svgId="m"
          onClick={() => {
            openMenu.value = false;
          }}
        />
      </Flex>
      <Flex
        display={{ base: "none", lg: "flex" }}
        alignItems="center"
        justifyContent="center"
        position="relative"
      >
        <Logo my={6} svgId="d" />
      </Flex>
      <AccountBar display={{ base: "flex", lg: "flex" }} />
      <SimpleGrid
        overflow="auto"
        borderTopWidth={1}
        borderTopColor="border.subtle"
        mt={6}
        pt={6}
        spacingY={0.5}
      >
        <MenuButton
          display={{ base: "inline-flex", lg: "none" }}
          to="/home"
          leftIcon={<Icon as={MdHome} boxSize={5} />}
        >
          {"Home"}
        </MenuButton>
        <MenuButton
          to="/objects"
          match={["/objects", "/container"]}
          leftIcon={<Icon as={TbTriangleSquareCircle} boxSize={5} />}
        >
          {"Non-Fungible Tokens"}
        </MenuButton>
        <MenuButton
          to="/fungible"
          match="/fungible"
          leftIcon={<Icon as={TbStack2} boxSize={5} />}
        >
          {"Fungible Tokens"}
        </MenuButton>
        <MenuButton
          to="/wave-names"
          leftIcon={<Icon as={HiOutlineAtSymbol} boxSize={5} />}
        >
          {"Wave Names"}
        </MenuButton>
        <MenuButton
          to="/coins"
          match={["/coins", "/history"]}
          leftIcon={<Icon as={TbHistory} boxSize={5} />}
        >
          {"History"}
        </MenuButton>
        <MenuButton
          to="/market"
          match={["/market"]}
          leftIcon={<Icon as={MdStorefront} boxSize={5} />}
        >
          {"Market"}
        </MenuButton>
        <MenuButton
          to="/swap"
          match={["/swap"]}
          leftIcon={<Icon as={RiSwap2Line} boxSize={5} />}
        >
          {"Swap"}
        </MenuButton>
        <MenuButton
          to="/predict"
          match={["/predict"]}
          leftIcon={<Icon as={TbChartLine} boxSize={5} />}
        >
          {"Predict"}
        </MenuButton>
        <MenuButton to="/vault" leftIcon={<Icon as={TbLock} boxSize={5} />}>
          {"Vault"}
        </MenuButton>
        <MenuButton to="/connect" leftIcon={<Icon as={MdLink} boxSize={5} />}>
          {"Connect & Sign"}
        </MenuButton>
      </SimpleGrid>
      <Box />
      <SyncBar />
      <SimpleGrid py={4} borderTopWidth={1} borderTopColor="border.subtle">
        <StatusBar />
      </SimpleGrid>
    </Grid>
  );
}
