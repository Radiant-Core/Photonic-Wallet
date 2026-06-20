import { Button } from "@chakra-ui/react";
import { t } from "@lingui/macro";
import { Link, Outlet, useLocation } from "react-router-dom";
import ContentContainer from "@app/components/ContentContainer";
import PageHeader from "@app/components/PageHeader";
import Toolbar from "@app/components/Toolbar";
import { ChevronRightIcon } from "@chakra-ui/icons";
import { language } from "@app/signals";

export default function SettingsLayout() {
  // Trigger rerender when language changes
  void language.value;

  const { pathname } = useLocation();
  const headings: { [key: string]: string } = {
    "/settings/wallet": t`Wallet`,
    "/settings/servers": t`Servers`,
    //"/settings/ipfs": t`IPFS`,
    "/settings/about": t`About`,
  };
  const heading = headings[pathname];

  return (
    <ContentContainer>
      <PageHeader>
        {t`Settings`}
        <ChevronRightIcon mx={2} color="text.muted" />
        {heading}
      </PageHeader>
      <Toolbar mb={6} pl={4} flexWrap="wrap" rowGap={2}>
        <Button size="sm" as={Link} to="/settings/wallet">
          {t`Wallet`}
        </Button>
        <Button size="sm" as={Link} to="/settings/servers">
          {t`Servers`}
        </Button>
        {/*<Button size="sm" as={Link} to="/settings/ipfs">
          {t`IPFS`}
        </Button>*/}
        <Button size="sm" as={Link} to="/settings/about">
          {t`About`}
        </Button>
        <Button size="sm" as={Link} to="/settings/logout">
          {t`Log out`}
        </Button>
      </Toolbar>
      <Outlet />
    </ContentContainer>
  );
}
