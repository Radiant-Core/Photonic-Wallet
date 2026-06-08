/**
 * AuthorityConfig — the "mint this NFT as an Authority token" control used by the
 * NFT creation flow (Mint.tsx). Verifies it emits `undefined` when off and a
 * well-formed AuthorityTokenConfig (scope / permissions[] / ISO expires /
 * revocable) when on.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChakraProvider } from "@chakra-ui/react";
import AuthorityConfig from "../../components/AuthorityConfig";

function setup() {
  const onChange = vi.fn();
  const utils = render(
    <ChakraProvider>
      <AuthorityConfig onChange={onChange} />
    </ChakraProvider>
  );
  return { onChange, ...utils };
}
const last = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls[fn.mock.calls.length - 1]?.[0];

describe("AuthorityConfig", () => {
  it("emits undefined while disabled", () => {
    const { onChange } = setup();
    expect(last(onChange)).toBeUndefined();
  });

  it("enabling emits a config with revocable defaulting to true", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getAllByRole("checkbox")[0]); // enable
    expect(last(onChange)).toEqual({
      scope: undefined,
      permissions: undefined,
      expires: undefined,
      revocable: true,
    });
  });

  it("captures scope, permissions (parsed), ISO expires and revocable", () => {
    const { onChange, container } = setup();
    fireEvent.click(screen.getAllByRole("checkbox")[0]); // enable

    fireEvent.change(screen.getByPlaceholderText("e.g. my-collection"), {
      target: { value: "my-collection" },
    });
    fireEvent.change(screen.getByPlaceholderText("mint, revoke"), {
      target: { value: "mint, revoke" },
    });
    fireEvent.change(
      container.querySelector('input[type="date"]') as HTMLInputElement,
      { target: { value: "2030-01-01" } }
    );
    // revocable is the second checkbox once the section is expanded.
    fireEvent.click(screen.getAllByRole("checkbox")[1]); // revocable -> false

    expect(last(onChange)).toEqual({
      scope: "my-collection",
      permissions: ["mint", "revoke"],
      expires: "2030-01-01T00:00:00.000Z",
      revocable: false,
    });
  });

  it("disabling again emits undefined", () => {
    const { onChange } = setup();
    const enable = () => screen.getAllByRole("checkbox")[0];
    fireEvent.click(enable()); // on
    expect(last(onChange)).toBeTruthy();
    fireEvent.click(enable()); // off
    expect(last(onChange)).toBeUndefined();
  });
});
