import { describe, expect, test } from "vitest";
import { normalizeSourceChunk } from "./normalizeSourceChunk";

// component/normalizeSourceChunk.test.ts — RED-then-GREEN, pure unit (zero
// I/O, zero Convex runtime).
//
// RED (recorded verbatim, captured BEFORE component/normalizeSourceChunk.ts
// existed):
//
//   FAIL  component/normalizeSourceChunk.test.ts [ component/normalizeSourceChunk.test.ts ]
//   Error: Cannot find module './normalizeSourceChunk' imported from
//   component/normalizeSourceChunk.test.ts
//
// What follows is the GREEN state, against the REAL object shape emitted by
// vantage-paperasse's droit-du-travail `normalize_legi.py` / `normalize_kali.py`
// / `normalize_fiches_travail.py` (legal_references: array of
// {code, article_id, article_cid, text}; source_ref: {pubId, url, repo,
// licence, date_maj}).

describe("normalizeSourceChunk — object legal_references/source_ref -> contract strings", () => {
  test("MUST_PASS: maps an object-shaped source chunk (legi/kali droit-du-travail shape) to the string contract", () => {
    const sourceChunk = {
      chunk_id: "LEGIARTI000006901111",
      text: "Article L1234-1 : le contrat de travail a duree indeterminee peut etre rompu...",
      section_title: null,
      legal_references: [
        {
          code: "Code du travail",
          article_id: "LEGIARTI000006901111",
          article_cid: "LEGIARTI000006901111",
          text: "L1234-1",
        },
      ],
      scope: "code-du-travail",
      source_ref: {
        pubId: "LEGIARTI000006901111",
        url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006901111",
        repo: "SocialGouv/legi-data",
        licence: "Licence Ouverte 2.0",
        date_maj: "2017-09-24",
      },
    };

    const result = normalizeSourceChunk(sourceChunk);

    expect(result.chunk_id).toBe("LEGIARTI000006901111");
    expect(result.text).toBe(sourceChunk.text);
    expect(result.section_title).toBeUndefined();
    expect(result.legal_references).toEqual(["Code du travail L1234-1"]);
    expect(typeof result.legal_references[0]).toBe("string");
    expect(result.source_ref).toBe(
      "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006901111",
    );
    expect(typeof result.source_ref).toBe("string");
  });

  test("MUST_PASS: already-string legal_references/source_ref pass through unchanged", () => {
    const sourceChunk = {
      chunk_id: "L1234-1_art1",
      text: "Article L1234-1 text.",
      section_title: "Rupture du contrat",
      legal_references: ["L1234-1"],
      source_ref: "code-travail/L1234-1",
    };

    const result = normalizeSourceChunk(sourceChunk);

    expect(result).toEqual(sourceChunk);
  });

  test("MUST_PASS: missing optional section_title is preserved as undefined, never fabricated", () => {
    const sourceChunk = {
      chunk_id: "id-1",
      text: "some text",
      legal_references: [] as unknown[],
      source_ref: "src/1",
    };

    const result = normalizeSourceChunk(sourceChunk);

    expect(result.section_title).toBeUndefined();
  });

  test("MUST_PASS: empty legal_references array maps to an empty string array", () => {
    const sourceChunk = {
      chunk_id: "id-2",
      text: "some text",
      legal_references: [] as unknown[],
      source_ref: { pubId: "p1", url: "https://example.org/p1", repo: "r", licence: "l" },
    };

    const result = normalizeSourceChunk(sourceChunk);

    expect(result.legal_references).toEqual([]);
    expect(result.source_ref).toBe("https://example.org/p1");
  });

  test("MUST_PASS: object source_ref without url falls back to pubId, never to a silent empty string", () => {
    const sourceChunk = {
      chunk_id: "id-3",
      text: "some text",
      legal_references: [],
      source_ref: { pubId: "pub-only-id", repo: "r", licence: "l" },
    };

    const result = normalizeSourceChunk(sourceChunk);

    expect(result.source_ref).toBe("pub-only-id");
  });

  test("MUST_PASS: object legal_reference missing code/text falls back to article_cid", () => {
    const sourceChunk = {
      chunk_id: "id-4",
      text: "some text",
      legal_references: [{ code: "", article_id: "a1", article_cid: "cid-4", text: "" }],
      source_ref: "src/4",
    };

    const result = normalizeSourceChunk(sourceChunk);

    expect(result.legal_references).toEqual(["cid-4"]);
  });

  test("MUST_REFUSE: an object source_ref with neither url nor pubId throws, naming the missing instrument", () => {
    const sourceChunk = {
      chunk_id: "id-5",
      text: "some text",
      legal_references: [],
      source_ref: { repo: "r", licence: "l" },
    };

    expect(() => normalizeSourceChunk(sourceChunk)).toThrow(/source_ref/);
  });

  // allow-no-task: continuation of CORPUS-CONTRACT (k175y0htt4cte8f2ps6m3vm6ad8bmanc)
  // under Eta's PR #6 REVISE — 2 missing MUST_REFUSE tests for the
  // legal_references object/non-object throw paths (normalizeSourceChunk.ts:58,62).
  test("MUST_REFUSE: an object legal_reference with none of code/text/article_cid/article_id set throws, naming the missing instrument", () => {
    const sourceChunk = {
      chunk_id: "id-6",
      text: "some text",
      legal_references: [{ repo: "unrelated-field" }],
      source_ref: "src/6",
    };

    expect(() => normalizeSourceChunk(sourceChunk)).toThrow(/legal_references/);
  });

  test("MUST_REFUSE: a legal_reference entry that is neither a string nor an object throws", () => {
    const sourceChunk = {
      chunk_id: "id-7",
      text: "some text",
      legal_references: [42],
      source_ref: "src/7",
    };

    expect(() => normalizeSourceChunk(sourceChunk)).toThrow(/legal_references/);
  });
});
