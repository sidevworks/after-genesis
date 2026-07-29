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
        .map((file) => relative(APP_ROOT, file));
      expect(offenders, `${name} found in: ${offenders.join(", ")}`).toEqual([]);
    });
  }

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
