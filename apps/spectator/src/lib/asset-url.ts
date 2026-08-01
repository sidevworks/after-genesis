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
 * ## Why there are two URL shapes
 *
 * The obvious host — `storage.googleapis.com/<bucket>/<path>` — needs an IAM
 * grant of `allUsers`, and this organisation enforces Domain Restricted
 * Sharing (`constraints/iam.allowedPolicyMemberDomains`), which forbids that
 * member in any policy. No bucket under the org can be made anonymously
 * readable through IAM, so that shape cannot be used here.
 *
 * Firebase Storage's download endpoint is governed by Security Rules instead,
 * and rules are not IAM. `storage.rules` opens exactly `spectator/**` and
 * denies everything else, which is *narrower* than the bucket-wide grant IAM
 * would have required: anything the media service writes outside that prefix
 * stays private by default rather than by remembering to keep it so.
 *
 * That endpoint percent-encodes the whole object path into a single segment
 * and needs `?alt=media` to return bytes rather than metadata, so the two
 * shapes cannot be produced by simple concatenation. Both are supported: a
 * plain prefix still works, which keeps a future CDN or a self-hosted origin a
 * configuration change rather than a code change.
 *
 * This is a read path and nothing more. Media cannot alter the world (§21), and
 * a spectator build has no canonical write route (§17) — an asset host is not a
 * capability, it is a file server.
 */
const RAW_BASE = process.env.NEXT_PUBLIC_ASSET_BASE_URL ?? "";

/** The configured base with any trailing slash removed, so joins stay clean. */
export const ASSET_BASE_URL = RAW_BASE.replace(/\/+$/, "");

/**
 * True when the base addresses Firebase Storage's rules-governed download
 * endpoint, whose object paths are one percent-encoded segment after `/o/`.
 */
function isFirebaseDownloadEndpoint(base: string): boolean {
  return base.startsWith("https://firebasestorage.googleapis.com/") && base.includes("/o/");
}

/**
 * Resolve `path` against `base`. Pure, so every shape is directly testable
 * without rebuilding the module to change an inlined environment variable.
 */
export function resolveAssetUrl(base: string, path: string): string {
  const relative = path.replace(/^\/+/, "");
  if (base === "") return `/${encodeURI(relative)}`;
  if (isFirebaseDownloadEndpoint(base)) {
    // `%2F` rather than `/`: the endpoint treats the object name as one
    // segment, and an unescaped slash addresses a different resource.
    return `${base}%2F${encodeURIComponent(relative)}?alt=media`;
  }
  return `${base}/${encodeURI(relative)}`;
}

/**
 * Resolve a public asset path against the configured host.
 *
 * `path` is always the root-relative form the file has under `public/`, so a
 * checkout without a bucket configured keeps working and the call sites read
 * the same either way.
 */
export function assetUrl(path: string): string {
  return resolveAssetUrl(ASSET_BASE_URL, path);
}
