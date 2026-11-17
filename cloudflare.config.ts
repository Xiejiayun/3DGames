import { defineConfig } from "cf/config";

export default defineConfig({
  accountId: "9198bde6a94accd267e7ead951ed037e",
  worker: {
    name: "game",
    compatibilityDate: "2026-11-17",
    assets: {
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "none",
    },
    workersDev: true,
    domains: ["game.jeremyxie.com"],
    observability: {
      enabled: true,
      traces: { enabled: true },
    },
  },
});
