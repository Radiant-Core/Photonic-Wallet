import { useState, FocusEvent } from "react";
import {
  Box,
  Container,
  Divider,
  Editable,
  EditableInput,
  EditablePreview,
  IconButton,
  Input,
  VStack,
  useEditableControls,
} from "@chakra-ui/react";
import {
  AddIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  DeleteIcon,
  EditIcon,
} from "@chakra-ui/icons";
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";
import { PromiseExtended } from "dexie";
import Card from "@app/components/Card";
import { wallet } from "@app/signals";
import { useToast } from "@chakra-ui/react";

/** Maximum number of Electrum servers allowed per network */
const MAX_SERVERS = 10;

/** Validate Electrum server URL - must use wss:// scheme for security */
function validateServerUrl(url: string): { valid: boolean; error?: string } {
  if (!url || typeof url !== "string") {
    return { valid: false, error: "Server URL is required" };
  }

  url = url.trim();

  // Must use secure WebSocket scheme
  if (!url.startsWith("wss://")) {
    if (url.startsWith("ws://")) {
      return {
        valid: false,
        error:
          "Insecure WebSocket (ws://) is not allowed. Use wss:// for secure connections.",
      };
    }
    return {
      valid: false,
      error:
        "Server URL must use wss:// scheme (e.g., wss://electrumx.example.com:50002)",
    };
  }

  try {
    const urlObj = new URL(url);
    if (urlObj.protocol !== "wss:") {
      return { valid: false, error: "URL must use wss:// protocol" };
    }
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  return { valid: true };
}

function NewControls() {
  const { getEditButtonProps } = useEditableControls();

  return (
    <IconButton
      icon={<AddIcon />}
      aria-label={"New"}
      size="sm"
      {...getEditButtonProps()}
    />
  );
}

function EditableControls() {
  const { getEditButtonProps } = useEditableControls();

  return (
    <IconButton
      icon={<EditIcon />}
      aria-label={"Edit"}
      size="sm"
      {...getEditButtonProps()}
    />
  );
}

// type Server = string;

export default function Servers() {
  const allServers = useLiveQuery(
    () =>
      db.kvp.get("servers") as PromiseExtended<{
        mainnet: string[];
        testnet: string[];
      }>,
    [],
    { mainnet: [], testnet: [] }
  );
  const [newKey, setNewKey] = useState(1);

  const toast = useToast();
  const servers = allServers[wallet.value.net];

  const newServer = (event: FocusEvent<HTMLInputElement>) => {
    const value = event.target.value.trim();
    if (!value) return;

    // Validate URL scheme
    const validation = validateServerUrl(value);
    if (!validation.valid) {
      toast({
        title: "Invalid Server URL",
        description: validation.error,
        status: "error",
        duration: 5000,
      });
      setNewKey(newKey + 1); // Reset the input
      return;
    }

    // Check max servers limit
    if (servers.length >= MAX_SERVERS) {
      toast({
        title: "Server Limit Reached",
        description: `Maximum ${MAX_SERVERS} servers allowed`,
        status: "warning",
        duration: 3000,
      });
      setNewKey(newKey + 1);
      return;
    }

    db.kvp.put(
      {
        ...allServers,
        [wallet.value.net]: [value, ...servers],
      },
      "servers"
    );

    toast({
      title: "Server Added",
      description: value,
      status: "success",
      duration: 2000,
    });

    // Recreate new editable by changing the key
    setNewKey(newKey + 1);
  };

  const removeServer = (index: number) => {
    const spliced = servers.slice();
    spliced.splice(index, 1);
    db.kvp.put({ ...allServers, [wallet.value.net]: spliced }, "servers");
  };

  const moveServer = (index: number, up: boolean) => {
    const spliced = servers.slice();
    spliced[index] = spliced.splice(
      index + (up ? -1 : 1),
      1,
      spliced[index]
    )[0];
    db.kvp.put({ ...allServers, [wallet.value.net]: spliced }, "servers");
  };

  const editServer = (index: number, value: string) => {
    const trimmedValue = value.trim();

    // Validate URL scheme
    const validation = validateServerUrl(trimmedValue);
    if (!validation.valid) {
      toast({
        title: "Invalid Server URL",
        description: validation.error,
        status: "error",
        duration: 5000,
      });
      return; // Don't save invalid URL
    }

    const edited = servers.slice();
    edited[index] = trimmedValue;
    db.kvp.put({ ...allServers, [wallet.value.net]: edited }, "servers");

    toast({
      title: "Server Updated",
      description: trimmedValue,
      status: "success",
      duration: 2000,
    });
  };

  return (
    <Container maxW="container.md" px={4}>
      <Card p={4}>
        <VStack spacing={2} align="stretch" divider={<Divider />}>
          <Box key="new" display="flex" alignItems="center" gap={2}>
            <Editable
              key={`new-${newKey}`}
              defaultValue=""
              flexGrow={1}
              display="flex"
              gap={4}
              alignItems="center"
              height={10}
            >
              <NewControls />
              <EditablePreview py={2} />
              <Input
                as={EditableInput}
                flexGrow={1}
                width="auto"
                onBlur={newServer}
              />
            </Editable>
          </Box>
          {servers.map((server, index) => (
            <Box
              key={`${server}-${index}`}
              display="flex"
              alignItems="center"
              gap={2}
            >
              <Editable
                defaultValue={server}
                flexGrow={1}
                display="flex"
                gap={4}
                alignItems="center"
                minHeight={10}
                wordBreak="break-all"
                onSubmit={(value) => editServer(index, value)}
              >
                <EditableControls />
                <EditablePreview />
                <Input as={EditableInput} flexGrow={1} width="auto" />
              </Editable>
              <IconButton
                icon={<ArrowUpIcon />}
                aria-label={"Move up"}
                size="sm"
                onClick={() => moveServer(index, true)}
                isDisabled={index === 0}
              />
              <IconButton
                icon={<ArrowDownIcon />}
                aria-label={"Move down"}
                size="sm"
                onClick={() => moveServer(index, false)}
                isDisabled={index + 1 === servers.length}
              />
              <IconButton
                icon={<DeleteIcon />}
                aria-label={"Delete"}
                size="sm"
                onClick={() => removeServer(index)}
              />
            </Box>
          ))}
        </VStack>
      </Card>
    </Container>
  );
}
