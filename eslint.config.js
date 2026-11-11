const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  {
    ignores: ["node_modules/**"],
  },
  {
    files: ["**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // These routes intentionally retain unreachable legacy implementations
    // below explicit 410/rollout returns as migration documentation.
    files: ["routes/entries.js", "routes/expenses.js", "routes/sales.js"],
    rules: {
      "no-unreachable": "off",
    },
  },
];
