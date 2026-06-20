import { Button, HStack, Icon } from "@chakra-ui/react";
import { Link, Outlet, useLocation } from "react-router-dom";
import ContentContainer from "@app/components/ContentContainer";
import PageHeader from "@app/components/PageHeader";
import { ChevronRightIcon } from "@chakra-ui/icons";
import { language } from "@app/signals";
import { TbChartLine, TbPlus } from "react-icons/tb";
import ActionIcon from "@app/components/ActionIcon";

export default function PredictLayout() {
  // Trigger rerender when language changes
  void language.value;

  const { pathname } = useLocation();
  const headings: { [key: string]: string } = {
    "/predict/create": "Create Market",
  };
  const heading = headings[pathname];

  return (
    <ContentContainer>
      <PageHeader
        toolbar={
          <Button
            variant="primary"
            as={Link}
            to="/predict/create"
            leftIcon={<Icon as={TbPlus} />}
            shadow="md"
          >
            New Market
          </Button>
        }
      >
        Predict
        {heading && (
          <>
            <ChevronRightIcon mx={2} /> {heading}
          </>
        )}
      </PageHeader>

      <HStack mb={8} px={4} wrap="wrap">
        <Button
          size="sm"
          as={Link}
          to="/predict"
          leftIcon={<ActionIcon as={TbChartLine} />}
        >
          Markets
        </Button>
        <Button
          size="sm"
          as={Link}
          to="/predict/create"
          leftIcon={<ActionIcon as={TbPlus} />}
        >
          Create
        </Button>
      </HStack>
      <Outlet />
    </ContentContainer>
  );
}
