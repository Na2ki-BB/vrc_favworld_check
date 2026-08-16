import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "artifacts/**",
      "coverage/**",
      "dist/**",
      "node_modules/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["extension/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.browser,
        ...globals.webextensions
      },
      sourceType: "module"
    },
    rules: {
      "no-console": "error"
    }
  },
  {
    files: ["scripts/**/*.mjs", "tests/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      sourceType: "module"
    }
  }
];
