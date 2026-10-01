import { definePlugin } from "@oxlint/plugins";

import namespaceNodeImports from "./rules/namespace-node-imports.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.ts";

// Copied from t3code oxlint-plugin-t3code (minus no-global-process-runtime, which needs T3's HostProcess service).
export default definePlugin({
  meta: {
    name: "toolreader",
  },
  rules: {
    "namespace-node-imports": namespaceNodeImports,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
  },
});
