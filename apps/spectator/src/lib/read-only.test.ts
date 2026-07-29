/**
 * The read-only guarantee, as a test.
 *
 *   claude.md §17 — "The public client must have no canonical write path."
 *   claude.md §20 — "The spectator interface must never contain controls
 *                    capable of influencing inhabitants."
 *   claude.md §28 — "No human-facing canonical write route exists."
 *
 * These are not comments in a file someone can edit away. This suite fails if:
 *
 *   1. any source file gains a form, a submitting control or a server action;
 *   2. any source file gains a way to send data anywhere at all;
 *   3. the app gains a route handler, middleware or a server rendering mode
 *      that could accept a request body;
 *   4. the `WorldSource` interface gains a member whose name is not a query;
 *   5. any *rendered* page in the static export contains a form or a control
 *      that submits.
 *
 * Assertion 5 is the important one: it inspects the actual HTML of every route
 * the build produced, so it cannot be satisfied by a comment, a convention or
 * good intentions. It is skipped (loudly) when `out/` has not been built yet;
 * run `npm run build` before `npm test` to exercise it.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(APP_ROOT, "src");
const OUT = join(APP_ROOT, "out");

function walk(dir: string, match: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full, match));
    } else if (match(full)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Source files that ship to a reader. Test files are excluded because this
 * file necessarily contains every string it forbids; the static-export check
 * below is what makes that exclusion safe, since it inspects what was actually
 * rendered rather than what was written.
 */
const sourceFiles = walk(
  SRC,
  (path) =>
    /\.(ts|tsx|js|jsx|mjs)$/.test(path) &&
    !path.endsWith(".test.ts") &&
    !path.includes(`${"fixtures"}/generate.mts`),
);

/**
 * Files permitted to call `fetch`, and the reason each is allowed.
 *
 * The blanket ban below exists because sending data anywhere is how a reader
 * stops being a reader. Reading a same-origin static file is the one shape
 * that cannot do that: it names a path, carries no body, uses the default GET
 * method and reaches nothing but this application's own published output.
 *
 * The allowlist is not the safeguard — an entry here only exempts a file from
 * the blanket pattern. `every allowed network call is a same-origin GET` below
 * then proves the calls in these files really are that shape, so adding a file
 * here cannot smuggle in a POST, a body or an external host.
 */
const ALLOWED_NETWORK_READS: ReadonlyMap<string, string> = new Map([
  [
    "src/lib/cinema/use-voice-manifest.ts",
    "GETs /voice/<reel>/manifest.json, a static file this app publishes (§21).",
  ],
]);

/** Each pattern is a way this application could stop being read-only. */
const FORBIDDEN_IN_SOURCE: Array<{ name: string; pattern: RegExp }> = [
  { name: "a form element", pattern: /<form[\s/>]/ },
  { name: "a submitting control", pattern: /type\s*=\s*["'{]?\s*["']?submit["']/i },
  { name: "a form action", pattern: /\bformAction\b/ },
  { name: "a submit handler", pattern: /\bonSubmit\b/ },
  { name: "an HTTP POST form method", pattern: /method\s*=\s*["'](post|put|patch|delete)["']/i },
  { name: "a server action directive", pattern: /["']use server["']/ },
  { name: "a mutating fetch", pattern: /method\s*:\s*["'](POST|PUT|PATCH|DELETE)["']/i },
  { name: "a network call", pattern: /(?<![\w.])fetch\s*\(/ },
  { name: "a beacon", pattern: /navigator\.sendBeacon/ },
  { name: "an XHR", pattern: /\bXMLHttpRequest\b/ },
  { name: "a socket", pattern: /new\s+WebSocket\b/ },
  { name: "an event source", pattern: /new\s+EventSource\b/ },
  { name: "a Firestore write", pattern: /\b(setDoc|addDoc|updateDoc|deleteDoc|writeBatch|runTransaction)\b/ },
];

describe("the spectator application has no write path in its source", () => {
  it("ships at least one source file to scan", () => {
    expect(sourceFiles.length).toBeGreaterThan(10);
  });

  for (const { name, pattern } of FORBIDDEN_IN_SOURCE) {
    it(`contains ${name} nowhere`, () => {
      const offenders = sourceFiles
        .filter((file) => pattern.test(readFileSync(file, "utf8")))
        .map((file) => relative(APP_ROOT, file))
        .filter((file) => !(name === "a network call" && ALLOWED_NETWORK_READS.has(file)));
      expect(offenders, `${name} found in: ${offenders.join(", ")}`).toEqual([]);
    });
  }

  it("every allowed network call is a same-origin GET of a static file", () => {
    for (const [file, reason] of ALLOWED_NETWORK_READS) {
      const source = readFileSync(join(APP_ROOT, file), "utf8");
      const calls = [...source.matchAll(/(?<![\w.])fetch\s*\(([^)]*)\)/g)].map((m) => m[1] ?? "");

      expect(calls.length, `${file} is allowlisted but calls no fetch — ${reason}`).toBeGreaterThan(
        0,
      );

      for (const call of calls) {
        // No second argument at all: no method, no body, no headers, no
        // credentials. A bare GET is the only request this app may make.
        expect(call.includes(","), `${file} passes options to fetch: ${call}`).toBe(false);
        // A same-origin absolute path. A scheme or a protocol-relative URL
        // would reach a host this application does not publish.
        expect(call.trim().startsWith("`/") || call.trim().startsWith('"/') || call.trim().startsWith("'/"),
          `${file} fetches something that is not a same-origin path: ${call}`).toBe(true);
      }
    }
  });

  it("allowlists no file that has since been deleted", () => {
    const stale = [...ALLOWED_NETWORK_READS.keys()].filter(
      (file) => !existsSync(join(APP_ROOT, file)),
    );
    expect(stale, `stale network allowlist entries: ${stale.join(", ")}`).toEqual([]);
  });

  it("defines no route handler, so there is no endpoint to POST to", () => {
    const handlers = walk(join(SRC, "app"), (path) =>
      /(^|\/)route\.(ts|tsx|js|jsx)$/.test(path),
    ).map((file) => relative(APP_ROOT, file));
    expect(handlers).toEqual([]);
  });

  it("defines no middleware, so no request is intercepted on the way in", () => {
    const middleware = [
      join(APP_ROOT, "middleware.ts"),
      join(SRC, "middleware.ts"),
      join(SRC, "app", "middleware.ts"),
    ].filter((path) => existsSync(path));
    expect(middleware).toEqual([]);
  });

  it("is configured as a static export, so it runs no server at all", () => {
    const config = readFileSync(join(APP_ROOT, "next.config.mjs"), "utf8");
    expect(config).toMatch(/output:\s*["']export["']/);
  });
});

/* ------------------------------------------------------------------------ */
/* Sign-in, and the wall between it and the world.                           */
/* ------------------------------------------------------------------------ */

/**
 * The spectator app has accounts: Google, email and anonymous "guest".
 * Authenticating writes a record into Firebase Authentication, which is the one
 * write this application performs and the one it must never be able to confuse
 * with a canonical write.
 *
 * The wall is structural rather than conventional. `firebase/auth` may be
 * imported only by the files listed below, and no file may import both
 * `firebase/auth` and `firebase/firestore`. That makes it impossible to reach a
 * canonical document from a sign-in code path without deleting a test, and the
 * blanket bans above still apply to the auth surface — it contains no form, no
 * submitting control and no fetch, like everything else here.
 *
 * A viewer's identity decides which spectator surfaces open for them. It is not
 * a capability inside the world: there is no action it unlocks, no inhabitant it
 * reaches and no state it can change (claude.md §17, §20, §28).
 */
const AUTH_SURFACE = [
  "src/lib/firebase/auth-client.ts",
  "src/components/auth/auth-context.tsx",
];

describe("authentication cannot reach canonical state", () => {
  const importsAuth = sourceFiles.filter((file) =>
    /from\s+["']firebase\/auth["']/.test(readFileSync(file, "utf8")),
  );

  it("confines the Firebase Auth SDK to the declared auth surface", () => {
    const unexpected = importsAuth
      .map((file) => relative(APP_ROOT, file))
      .filter((file) => !AUTH_SURFACE.includes(file));
    expect(
      unexpected,
      `firebase/auth imported outside the auth surface: ${unexpected.join(", ")}`,
    ).toEqual([]);
  });

  it("declares no auth-surface file that has since been deleted", () => {
    const stale = AUTH_SURFACE.filter((file) => !existsSync(join(APP_ROOT, file)));
    expect(stale, `stale auth surface entries: ${stale.join(", ")}`).toEqual([]);
  });

  it("never imports Firestore into a file that can sign anyone in", () => {
    const both = importsAuth
      .filter((file) => /from\s+["']firebase\/firestore["']/.test(readFileSync(file, "utf8")))
      .map((file) => relative(APP_ROOT, file));
    expect(
      both,
      `these files can both authenticate and touch Firestore: ${both.join(", ")}`,
    ).toEqual([]);
  });

  it("never reads the world from an auth-surface file", () => {
    const leaks = AUTH_SURFACE.filter((file) =>
      /\bworldSource\b|from\s+["']@\/lib\/world-source["']/.test(
        readFileSync(join(APP_ROOT, file), "utf8"),
      ),
    );
    expect(leaks, `auth surface reaching the world source: ${leaks.join(", ")}`).toEqual([]);
  });

  it("ships no service-account credential to the browser", () => {
    /*
     * The one mistake that would hand the world's write key to every visitor.
     *
     * Secret *values* are banned outright. Secret *names* are banned only where
     * they are read — `process.env.X` — because several files legitimately
     * explain in prose which credential they must never touch, and forbidding
     * the words would delete the explanation rather than the risk.
     */
    const FORBIDDEN_CREDENTIAL = [
      /"?type"?\s*:\s*["']service_account["']/,
      /\bprivate_key\b/,
      /BEGIN\s+PRIVATE\s+KEY/,
      /process\.env\.GOOGLE_APPLICATION_CREDENTIALS/,
      /process\.env\.GEMINI_API_KEY/,
      /process\.env\.ELEVENLABS_API_KEY/,
      /process\.env\.FIREBASE_[A-Z_]+/,
    ];
    for (const pattern of FORBIDDEN_CREDENTIAL) {
      const offenders = sourceFiles
        .filter((file) => pattern.test(readFileSync(file, "utf8")))
        .map((file) => relative(APP_ROOT, file));
      expect(offenders, `${pattern} found in: ${offenders.join(", ")}`).toEqual([]);
    }
  });
});

describe("the WorldSource interface exposes queries and nothing else", () => {
  const source = readFileSync(join(SRC, "lib", "world-source.ts"), "utf8");
  const body = source.slice(
    source.indexOf("export interface WorldSource {"),
    source.indexOf("\n}", source.indexOf("export interface WorldSource {")),
  );
  const members = [...body.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*\(/gm)].map((m) => m[1]!);

  it("declares the members the spectator pages need", () => {
    expect(members).toEqual(
      expect.arrayContaining([
        "getWorldSummary",
        "getMap",
        "getInhabitants",
        "getInhabitant",
        "getEvents",
        "getOrganisations",
        "getArtifacts",
        "getEconomy",
        "getLineage",
        "getAuditStatus",
      ]),
    );
  });

  it("names every member as a read", () => {
    const notReads = members.filter((name) => !/^(get|list|search|find)[A-Z]/.test(name));
    expect(notReads, `non-query members: ${notReads.join(", ")}`).toEqual([]);
  });

  it("declares no member that could mutate world state", () => {
    const mutating = members.filter((name) =>
      /^(set|put|post|add|create|update|delete|remove|write|send|submit|propose|apply|mutate|freeze|edit)/i.test(
        name,
      ),
    );
    expect(mutating, `mutating members: ${mutating.join(", ")}`).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* The rendered pages themselves.                                            */
/* ------------------------------------------------------------------------ */

const renderedPages = walk(OUT, (path) => path.endsWith(".html"));

describe.skipIf(renderedPages.length === 0)(
  "no rendered route contains a control that submits toward world state",
  () => {
    const EXPECTED_ROUTES = [
      "index.html",
      "overview/index.html",
      "map/index.html",
      "inhabitants/index.html",
      "lineage/index.html",
      "events/index.html",
      "organisations/index.html",
      "economy/index.html",
      "artifacts/index.html",
      "audit/index.html",
    ];

    it("built every spectator route", () => {
      const missing = EXPECTED_ROUTES.filter((route) => !existsSync(join(OUT, route)));
      expect(missing, `routes missing from the export: ${missing.join(", ")}`).toEqual([]);
    });

    const FORBIDDEN_IN_HTML: Array<{ name: string; pattern: RegExp }> = [
      { name: "a <form> element", pattern: /<form[\s/>]/i },
      { name: 'a type="submit" control', pattern: /type=["']?submit/i },
      { name: "a formaction attribute", pattern: /formaction=/i },
      { name: "a non-GET form method", pattern: /method=["']?(post|put|patch|delete)/i },
      { name: "an action attribute on a form", pattern: /<form[^>]*\saction=/i },
      { name: "a file upload control", pattern: /type=["']?file/i },
    ];

    for (const page of renderedPages) {
      const route = relative(OUT, page);
      const html = readFileSync(page, "utf8");

      for (const { name, pattern } of FORBIDDEN_IN_HTML) {
        it(`${route} renders ${name} nowhere`, () => {
          expect(pattern.test(html), `${route} rendered ${name}`).toBe(false);
        });
      }
    }

    it("renders reading controls only — search, filter and zoom", () => {
      const events = readFileSync(join(OUT, "events", "index.html"), "utf8");
      // The timeline has a search box and filters. They must not be in a form.
      expect(events).toMatch(/<input[^>]*type="search"/i);
      expect(/<form[\s/>]/i.test(events)).toBe(false);
      // Every <button> in the export is a type="button": nothing submits.
      const buttons = [...events.matchAll(/<button[^>]*>/gi)].map((m) => m[0]);
      for (const button of buttons) {
        expect(button, `button without type="button": ${button}`).toMatch(/type="button"/i);
      }
    });
  },
);

if (renderedPages.length === 0) {
  describe("rendered-page checks", () => {
    it.skip("requires `npm run build` first — run it to exercise the strongest check", () => {
      /* intentionally skipped */
    });
  });
}
