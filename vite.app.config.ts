// The history webapp (src/app): TanStack Start, served by its own server, reading the history
// backend and GitHub. `vp dev -c vite.app.config.ts`; `vp build -c vite.app.config.ts` writes
// dist/app.
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  server: { host: "127.0.0.1", port: Number(process.env.APP_PORT ?? 4792), strictPort: true },
  plugins: [
    tanstackStart({ srcDirectory: "src/app", router: { generatedRouteTree: "routeTree.gen.ts" } }),
    // React's plugin must come after Start's.
    react(),
  ],
  build: { outDir: "dist/app" },
});
