import { describe, expect, it } from "vitest";

import { filterDiffRecords, filterDiffResponse } from "../src/lib/diff-filter.js";

const records = [
  { new_path: "src/index.ts", old_path: "src/index.ts", diff: "source" },
  { new_path: "vendor/generated.js", old_path: "vendor/generated.js", diff: "generated" },
  { new_path: "package-lock.json", old_path: "package-lock.json", diff: "lock" }
];

describe("diff filtering", () => {
  it("filters common bounded regex patterns against old and new paths", () => {
    expect(filterDiffRecords(records, ["^vendor/", "lock\\.json$"])).toEqual([records[0]]);
  });

  it("filters array and object response shapes without dropping metadata", () => {
    expect(filterDiffResponse({ commit: { id: "abc" }, diffs: records }, ["^vendor/"])).toEqual({
      commit: { id: "abc" },
      diffs: [records[0], records[2]]
    });
    expect(filterDiffResponse(records, ["^vendor/"])).toEqual([records[0], records[2]]);
  });

  it.each([
    "(a+)+$",
    "(a|aa)+$",
    "a+a+$",
    "a?a?",
    "a{1,3}a{1,3}",
    "(?=vendor)vendor",
    "(vendor)\\1",
    "["
  ])("rejects unsafe or invalid pattern %s", (pattern) => {
    expect(() => filterDiffRecords(records, [pattern])).toThrow(/excluded_file_patterns/u);
  });

  it("bounds pattern count and length", () => {
    expect(() =>
      filterDiffRecords(
        records,
        Array.from({ length: 21 }, () => "vendor")
      )
    ).toThrow(/at most 20/u);
    expect(() => filterDiffRecords(records, ["x".repeat(201)])).toThrow(/1-200/u);
  });
});
