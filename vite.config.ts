import "vite-plus/test/config";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const apiPort = Number(process.env.PORT ?? 4777);

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": `http://127.0.0.1:${apiPort}` } },
  // The viewer goes to dist/client, the static ledger page to dist/site (vite.site.config.ts), and
  // the CLI to dist/bin.mjs (`vp pack`, as t3code's server does: Node won't strip types in node_modules).
  build: { outDir: "dist/client" },
  pack: {
    entry: ["src/server/bin.ts"],
    outDir: "dist",
    clean: false,
    deps: { onlyBundle: false },
    banner: { js: "#!/usr/bin/env node\n" },
  },
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
  staged: {
    // Formatter only, same as t3code — no lint or typecheck on commit.
    "*": "vp fmt",
  },
  fmt: {
    ignorePatterns: ["dist", "node_modules", "pnpm-lock.yaml", "*.tsbuildinfo", "patches"],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: ["dist", "node_modules", "pnpm-lock.yaml", "*.tsbuildinfo"],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin/index.ts"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    // Same opt-outs as t3code.
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "toolreader/no-inline-schema-compile": "warn",
      "toolreader/no-manual-effect-runtime-in-tests": "error",
      "toolreader/namespace-node-imports": "error",
    },
    options: {
      typeAware: false,
      typeCheck: false,
    },
  },
});
