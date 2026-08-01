/**
 * Where the spectator's heavy media lives.
 *
 * Character models, terrain, profile films and rendered speech are hundreds of
 * megabytes together. Committing them makes every clone and every deployment
 * carry the whole set forever, so they live in Cloud Storage instead — which is
 * what claude.md §3 designates for "audio, artwork and media artifacts" — and
 * the pages address them through this helper.
 *
 * `NEXT_PUBLIC_ASSET_BASE_URL` is inlined by Next at build time. Left unset it
 * resolves to the empty string, which is exactly the old root-relative path, so
 * a local checkout with the files still under `public/` behaves as before and
 * nothing here depends on a bucket existing.
 *
 * This is a read path and nothing more. Media cannot alter the world (§21), and
 * a spectator build has no canonical write route (§17) — an asset host is not a
 * capability, it is a file server.
 */
const RAW_BASE = process.env.NEXT_PUBLIC_ASSET_BASE_URL ?? "";

/** The configured base with any trailing slash removed, so joins stay clean. */
export const ASSET_BASE_URL = RAW_BASE.replace(/\/+$/, "");

/**
 * Resolve a public asset path against the configured host.
 *
 * `path` is always the root-relative form the file has under `public/`, so a
 * checkout without a bucket configured keeps working and the call sites read
 * the same either way.
 */
export function assetUrl(path: string): string {
  const rooted = path.startsWith("/") ? path : `/${path}`;
  return `${ASSET_BASE_URL}${encodeURI(rooted)}`;
}
