const { defineConfig } = require("eslint/config");
const js = require("@eslint/js");
const typescript = require("@typescript-eslint/eslint-plugin");

module.exports = defineConfig({
  files: ["src/**/*.ts", "webview-src/**/*.{ts,tsx}"],
  extends: [js.configs.recommended, typescript.configs["flat/recommended-type-checked"]],
  languageOptions: {
    parserOptions: {
      project: ["./tsconfig.json", "./tsconfig.webview.json", "./tsconfig.eslint.json"],
      tsconfigRootDir: __dirname
    }
  },
  rules: {
    "@typescript-eslint/naming-convention": [
      "warn",
      {
        selector: "default",
        format: ["camelCase", "PascalCase", "UPPER_CASE"],
        leadingUnderscore: "allow",
        trailingUnderscore: "allow"
      },
      {
        selector: "variable",
        format: ["camelCase", "PascalCase", "UPPER_CASE"],
        leadingUnderscore: "allow",
        trailingUnderscore: "allow"
      },
      {
        selector: "typeLike",
        format: ["PascalCase"]
      },
      {
        selector: "enumMember",
        format: ["PascalCase", "UPPER_CASE"]
      },
      {
        selector: "objectLiteralProperty",
        format: null
      },
      {
        selector: "interface",
        format: ["PascalCase"]
      },
      {
        selector: "property",
        format: null
      }
    ],
    "@typescript-eslint/explicitFunctionReturnType": "off",
    "@typescript-eslint/no-unused-vars": [
      "warn",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_"
      }
    ],
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/prefer-nullish-coalescing": "warn",
    "@typescript-eslint/prefer-optional-chain": "warn",
    "@typescript-eslint/prefer-readonly": "warn",
    "@typescript-eslint/await-thenable": "error",
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
    "@typescript-eslint/unbound-method": "warn",
    "@typescript-eslint/no-unnecessary-type-assertion": "warn",
    "@typescript-eslint/require-array-sort-compare": "warn",
    "@typescript-eslint/prefer-includes": "warn",
    "@typescript-eslint/prefer-string-starts-ends-with": "warn",
    "no-console": "off",
    eqeqeq: [
      "warn",
      "always",
      {
        null: "ignore"
      }
    ],
    curly: ["warn", "all"],
    "no-caller": "error",
    "no-eval": "error",
    "no-labels": "error",
    "no-new-wrappers": "warn",
    "no-throw-literal": "error",
    radix: "warn",
    "no-irregular-whitespace": "warn"
  }
});
