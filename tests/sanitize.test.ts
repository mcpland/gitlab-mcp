import { describe, expect, it } from "vitest";

import { stripNullsDeep } from "../src/lib/sanitize.js";

describe("stripNullsDeep", () => {
  it("removes null values recursively from objects", () => {
    const input = {
      title: "demo",
      description: null,
      nested: {
        keep: 1,
        drop: null,
        arr: [1, null, 2, null, 3]
      }
    };

    expect(stripNullsDeep(input)).toEqual({
      title: "demo",
      nested: {
        keep: 1,
        arr: [1, 2, 3]
      }
    });
  });
});
