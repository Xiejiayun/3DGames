import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist");
const pages = execFileSync("git", ["ls-files", "-z", "--", "*.html"], {
  cwd: root,
  encoding: "utf8",
}).split("\0").filter(Boolean);

if (!pages.includes("index.html")) {
  throw new Error("A tracked index.html is required as the site homepage.");
}

// Rebuild the public directory from tracked HTML only, preserving relative paths.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const page of pages) {
  const destination = join(output, page);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, page), destination);
}
console.log(`Prepared ${pages.length} HTML pages in dist/.`);
