import { ContractType } from "@app/types";

export default function ContractName({
  contractType,
}: {
  contractType: ContractType;
}) {
  return {
    [ContractType.FT]: "Fungible tokens",
    [ContractType.NFT]: "Non-fungible tokens",
    [ContractType.RXD]: "RXD",
    [ContractType.VAULT]: "Vault",
  }[contractType];
}
