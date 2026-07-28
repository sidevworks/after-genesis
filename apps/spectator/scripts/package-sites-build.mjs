/**
 * Adapts the validated static Next.js export to the Sites deployment contract.
 * The worker delegates every request to the immutable static asset binding.
 */

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const project = resolve(import.meta.dirname, "..");
const repository = resolve(project, "../..");
const output = resolve(project, "out");
const dist = resolve(repository, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "server"), { recursive: true });
await cp(output, resolve(dist, "client"), { recursive: true });
await writeFile(
  resolve(dist, "server/index.js"),
  [
    "export default {",
    "  async fetch(request, env) {",
    "    const url = new URL(request.url);",
    "    if (/^\\/world\\/[^/]+\\/(ref|event|watch)\\/[^/]+\\/?$/.test(url.pathname)) {",
    "      url.pathname = '/reference/index.html';",
    "      return env.ASSETS.fetch(new Request(url, request));",
    "    }",
    "    return env.ASSETS.fetch(request);",
    "  },",
    "};",
    "",
  ].join("\n"),
  "utf8",
);
