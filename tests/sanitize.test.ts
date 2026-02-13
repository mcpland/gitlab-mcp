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

  it("returns undefined for top-level null", () => {
    expect(stripNullsDeep(null)).toBeUndefined();
  });

  it("preserves primitive string values", () => {
    expect(stripNullsDeep("hello")).toBe("hello");
  });

  it("preserves primitive number values", () => {
    expect(stripNullsDeep(42)).toBe(42);
    expect(stripNullsDeep(0)).toBe(0);
    expect(stripNullsDeep(-1)).toBe(-1);
  });

  it("preserves boolean values", () => {
    expect(stripNullsDeep(true)).toBe(true);
    expect(stripNullsDeep(false)).toBe(false);
  });

  it("preserves undefined as-is", () => {
    expect(stripNullsDeep(undefined)).toBeUndefined();
  });

  it("handles empty object", () => {
    expect(stripNullsDeep({})).toEqual({});
  });

  it("handles empty array", () => {
    expect(stripNullsDeep([])).toEqual([]);
  });

  it("handles object with all null values", () => {
    expect(stripNullsDeep({ a: null, b: null, c: null })).toEqual({});
  });

  it("handles array with all null values", () => {
    expect(stripNullsDeep([null, null, null])).toEqual([]);
  });

  it("handles deeply nested null removal", () => {
    const input = {
      level1: {
        level2: {
          level3: {
            keep: "value",
            drop: null
          }
        }
      }
    };

    expect(stripNullsDeep(input)).toEqual({
      level1: {
        level2: {
          level3: {
            keep: "value"
          }
        }
      }
    });
  });

  it("handles mixed array contents", () => {
    const input = [1, "hello", null, true, null, { key: null, keep: "yes" }];

    expect(stripNullsDeep(input)).toEqual([1, "hello", true, { keep: "yes" }]);
  });

  it("handles nested arrays within objects", () => {
    const input = {
      items: [{ name: "a", value: null }, null, { name: "b", value: 1 }]
    };

    expect(stripNullsDeep(input)).toEqual({
      items: [{ name: "a" }, { name: "b", value: 1 }]
    });
  });

  it("preserves zero, empty string, and false values", () => {
    const input = {
      zero: 0,
      emptyStr: "",
      falsy: false,
      nullValue: null
    };

    expect(stripNullsDeep(input)).toEqual({
      zero: 0,
      emptyStr: "",
      falsy: false
    });
  });

  it("handles arrays nested within arrays", () => {
    const input = [[null, 1], [2, null], null];
    expect(stripNullsDeep(input)).toEqual([[1], [2]]);
  });
});
