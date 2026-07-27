/**
 * After Genesis — spectator application.
 *
 * `output: "export"` is a product decision, not a deployment convenience.
 * The spectator app is compiled to a directory of static files. There is no
 * server process, no route handler, no server action and therefore no
 * endpoint that could accept a write directed at the canonical world
 * (claude.md §17 "The public client must have no canonical write path",
 * §20 "The spectator interface must never contain controls capable of
 * influencing inhabitants", §28 "No human-facing canonical write route exists").
 *
 * If a future data source needs incremental revalidation, replace this with
 * a read-only ISR configuration — never with route handlers or server actions.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  output: "export",
  reactStrictMode: true,
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
