import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist");
const files = execFileSync("git", ["ls-files", "-z", "--", "*.html", "assets/previews/*.webp"], {
  cwd: root,
  encoding: "utf8",
}).split("\0").filter(Boolean);

if (!files.includes("index.html")) {
  throw new Error("A tracked index.html is required as the site homepage.");
}

// Publish tracked pages and game previews, preserving their relative paths.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of files) {
  const destination = join(output, file);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, file), destination);
}
console.log(`Prepared ${files.length} site files in dist/.`);
