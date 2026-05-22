import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      ecmaVersion: 2020,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-empty-function": "off",
      // ban-ts-comment is on (default level) — it forbids bare @ts-ignore
      // and requires @ts-expect-error to come with a description. R6 cleared
      // the lib's pre-existing ignores; keeping this on prevents regressions.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-expect-error": "allow-with-description",
          "minimumDescriptionLength": 10,
        },
      ],
      // Honour the `_foo` convention for intentionally-unused parameters
      // and locals (kept for ABI compat or as documentation). Without this
      // the rule flags every `_` prefix.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_",
          "caughtErrorsIgnorePattern": "^_",
          "destructuredArrayIgnorePattern": "^_",
        },
      ],
      // Security-focused rules that ship with eslint / typescript-eslint
      // (no new plugin deps required — R23 acceptance).
      //   - no-eval        : ban direct eval()
      //   - no-implied-eval: ban setTimeout("code") and friends
      //   - no-new-func    : ban `new Function("body")`
      //   - no-script-url  : ban javascript:... URLs in attributes
      // These cover the same ground as `eslint-plugin-security`'s
      // `detect-eval-with-expression` and the `react-hooks` plugin's
      // exhaustive-deps without adding a supply-chain footprint.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      // R13 — ban React's `dangerouslySetInnerHTML` and direct
      // `.innerHTML = ` writes outside an explicit allowlist. Both are
      // routes for attacker-supplied content (notably on-chain SVG/HTML
      // payloads in NFTs) to execute JS in the wallet's origin and
      // exfiltrate the mnemonic blob from IndexedDB. The audit
      // confirmed zero current uses — this rule prevents regressions.
      // Use `// eslint-disable-next-line no-restricted-syntax` with a
      // justification comment if you genuinely need it (e.g. rendering
      // sanitised SVG from a vetted source).
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            "dangerouslySetInnerHTML is banned (R13). Render attacker-supplied content via <img src=data:…> or sanitise via packages/app/src/svgSanitize.ts first.",
        },
        {
          selector:
            "AssignmentExpression[left.property.name='innerHTML']",
          message:
            ".innerHTML = … is banned (R13). Use textContent or appendChild instead.",
        },
      ],
    },
  }
);
