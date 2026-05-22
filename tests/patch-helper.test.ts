import { describe, expect, it } from "vitest";

import {
  applySearchReplace,
  applyUnifiedDiff,
  parseSearchReplaceBlocks
} from "../src/lib/patch-helper.js";

describe("patch helper", () => {
  it("parses search/replace blocks while preserving leading blank lines", () => {
    const blocks = parseSearchReplaceBlocks(
      "<<<<<<< SEARCH\n\nold\n=======\n\nnew\n>>>>>>> REPLACE"
    );

    expect(blocks).toEqual([{ search: "\nold", replace: "\nnew" }]);
  });

  it("rejects duplicate search matches unless allowMultiple is true", () => {
    const blocks = [{ search: "same", replace: "changed" }];

    expect(() => applySearchReplace("same\nsame", blocks)).toThrow("matches 2 times");
    expect(applySearchReplace("same\nsame", blocks, true).description).toBe("changed\nchanged");
  });

  it("applies unified diffs with context validation", () => {
    const result = applyUnifiedDiff(
      "one\ntwo\nthree",
      "--- current\n+++ updated\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three"
    );

    expect(result.description).toBe("one\nTWO\nthree");
    expect(result.changes).toBe(2);
  });
});
