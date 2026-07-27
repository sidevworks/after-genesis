/**
 * Behavioural checks on the fixture source and the presentation invariants the
 * spectator app depends on (claude.md §8, §11G, §11J, §12, §16).
 */

import { describe, expect, it } from "vitest";
import { FixtureWorldSource } from "./fixture-world-source";
import { hashEvent, verifyEventChain } from "./event-hash";

const source = new FixtureWorldSource();

describe("the committed event log is a real hash chain", () => {
  it("verifies from Genesis to the head", async () => {
    const audit = await source.getAuditStatus();
    expect(audit.chain.verified).toBe(true);
    expect(audit.chain.brokenAtSequence).toBeUndefined();
    expect(audit.chain.eventCount).toBeGreaterThan(200);
  });

  it("detects a tampered description", async () => {
    const page = await source.getEvents({ limit: 1000 });
    const events = [...page.events].sort((a, b) => a.sequence - b.sequence);
    const target = events[10]!;
    const tampered = events.map((event) =>
      event.sequence === target.sequence
        ? { ...event, description: "Something entirely different happened." }
        : event,
    );
    const result = verifyEventChain(tampered);
    expect(result.verified).toBe(false);
    expect(result.brokenAtSequence).toBe(target.sequence);
  });

  it("recomputes each hash from the canonical payload rather than trusting it", async () => {
    const page = await source.getEvents({ limit: 5 });
    for (const event of page.events) {
      expect(hashEvent(event)).toBe(event.hash);
    }
  });
});

describe("death never deletes history (§8)", () => {
  it("keeps deceased inhabitants fully browsable", async () => {
    const all = await source.getInhabitants();
    const deceased = all.filter((i) => i.status === "deceased");
    expect(deceased.length).toBeGreaterThan(0);

    for (const summary of deceased) {
      const inhabitant = await source.getInhabitant(summary.id);
      expect(inhabitant).not.toBeNull();
      expect(inhabitant!.death).toBeDefined();
      expect(inhabitant!.relationships.length).toBeGreaterThan(0);
      expect(inhabitant!.health.history.length).toBeGreaterThan(0);
      expect(inhabitant!.creationEventId).toBeTruthy();

      const events = await source.getEvents({ limit: 500, filter: { subjectId: summary.id } });
      expect(events.total).toBeGreaterThan(0);
    }
  });

  it("keeps a deceased inhabitant's artifacts in the world", async () => {
    const artifacts = await source.getArtifacts();
    const inherited = artifacts.find((a) => a.provenance.some((p) => p.kind === "inherited"));
    expect(inherited).toBeDefined();
    expect(inherited!.provenance.length).toBeGreaterThan(1);
  });
});

describe("canonical facts and claims stay separate (§11G, §11J)", () => {
  it("stores claims as attributed records beside events, never inside descriptions", async () => {
    const page = await source.getEvents({ limit: 1000, filter: { withClaimsOnly: true } });
    expect(page.total).toBeGreaterThan(0);

    for (const event of page.events) {
      for (const claim of event.claims) {
        expect(claim.byId).toBeTruthy();
        expect(claim.byName).toBeTruthy();
        expect(["inhabitant", "organisation"]).toContain(claim.byKind);
        // The canonical description must not have absorbed the claim text.
        expect(event.description).not.toContain(claim.text);
      }
    }
  });

  it("keeps the confinement event neutral while the organisation's framing stays a claim", async () => {
    const page = await source.getEvents({
      limit: 1000,
      filter: { types: ["impose_confinement"] },
    });
    const event = page.events[0];
    expect(event).toBeDefined();
    expect(event!.description).toMatch(/confined .* inside .* from Day \d+ \d\d:\d\d/);
    expect(event!.description).not.toMatch(/lawful|unlawful|criminal|justly|rightly/i);

    const orgClaim = event!.claims.find((c) => c.byKind === "organisation");
    expect(orgClaim).toBeDefined();
    expect(orgClaim!.text).toMatch(/lawfully/i);
  });

  it("records an organisation's declared rules as its own text, not as world rules", async () => {
    const organisations = await source.getOrganisations();
    for (const org of organisations) {
      for (const rule of org.declaredRules) {
        expect(Array.isArray(rule.recognisedBy)).toBe(true);
        expect(Array.isArray(rule.rejectedBy)).toBe(true);
      }
      const total =
        org.recognition.recognisedByIds.length +
        org.recognition.rejectedByIds.length +
        org.recognition.unengagedIds.length;
      const inhabitants = await source.getInhabitants();
      expect(total).toBe(inhabitants.length);
    }
  });
});

describe("generated media is distinguishable from canonical action (§12)", () => {
  it("labels every media item with a kind and a statement of no effect", async () => {
    const artifacts = await source.getArtifacts();
    const media = artifacts.flatMap((a) => a.generatedMedia);
    expect(media.length).toBeGreaterThan(0);
    for (const item of media) {
      expect(["verbatim_dialogue", "condensed_summary", "dramatised_narration"]).toContain(
        item.kind,
      );
      expect(item.producedBy).toBeTruthy();
      expect(item.note.length).toBeGreaterThan(20);
    }
  });
});

describe("query behaviour", () => {
  it("paginates newest first and hands back a usable cursor", async () => {
    const first = await source.getEvents({ limit: 10 });
    expect(first.events).toHaveLength(10);
    expect(first.events[0]!.sequence).toBeGreaterThan(first.events[9]!.sequence);
    expect(first.nextCursor).not.toBeNull();

    const second = await source.getEvents({ limit: 10, cursor: first.nextCursor! });
    expect(second.events[0]!.sequence).toBeLessThan(first.events[9]!.sequence);
  });

  it("searches descriptions and hashes", async () => {
    const page = await source.getEvents({ limit: 100, filter: { search: "Stone Hall" } });
    expect(page.total).toBeGreaterThan(0);
    for (const event of page.events) {
      expect(event.description.toLowerCase()).toContain("stone hall");
    }
  });

  it("returns null for an inhabitant that never existed", async () => {
    expect(await source.getInhabitant("INH-999")).toBeNull();
  });
});
