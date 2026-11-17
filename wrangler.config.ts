import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  // cf uses Wrangler's static-site builder to package the prepared HTML pages.
  assetsDirectory: "./dist",
});
