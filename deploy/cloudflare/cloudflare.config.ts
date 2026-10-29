import { defineConfig, bindings } from "cf/config";

export default defineConfig({
  worker: {
    name: "forkfield",
    entrypoint: "./src/index.js",
    compatibilityDate: "2026-09-21",
    observability: { enabled: true },
    // API, clips and workflows go to the Worker; everything else is static.
    assets: { runWorkerFirst: ["/api/*", "/clips/*", "/samples/*", "/workflows/*"] },
    env: {
      CLIPS: bindings.kv(),
      ASSETS: bindings.assets(),
      DAILY_LIMIT: bindings.text("30"),
      PER_IP_LIMIT: bindings.text("3"),
    },
  },
});
