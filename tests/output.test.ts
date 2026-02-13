import { describe, expect, it } from "vitest";

import { OutputFormatter } from "../src/lib/output.js";

describe("OutputFormatter", () => {
  describe("json mode", () => {
    it("formats objects with 2-space indentation", () => {
      const formatter = new OutputFormatter({ responseMode: "json", maxBytes: 10_000 });
      const result = formatter.format({ hello: "world", count: 42 });

      expect(result.text).toBe(JSON.stringify({ hello: "world", count: 42 }, null, 2));
      expect(result.truncated).toBe(false);
      expect(result.bytes).toBeGreaterThan(0);
    });

    it("formats arrays", () => {
      const formatter = new OutputFormatter({ responseMode: "json", maxBytes: 10_000 });
      const result = formatter.format([1, 2, 3]);

      expect(result.text).toBe(JSON.stringify([1, 2, 3], null, 2));
      expect(result.truncated).toBe(false);
    });

    it("formats null", () => {
      const formatter = new OutputFormatter({ responseMode: "json", maxBytes: 10_000 });
      const result = formatter.format(null);

      expect(result.text).toBe("null");
      expect(result.truncated).toBe(false);
    });

    it("formats primitive strings", () => {
      const formatter = new OutputFormatter({ responseMode: "json", maxBytes: 10_000 });
      const result = formatter.format("hello");

      expect(result.text).toBe('"hello"');
      expect(result.truncated).toBe(false);
    });

    it("formats numbers", () => {
      const formatter = new OutputFormatter({ responseMode: "json", maxBytes: 10_000 });
      const result = formatter.format(42);

      expect(result.text).toBe("42");
      expect(result.truncated).toBe(false);
    });

    it("formats booleans", () => {
      const formatter = new OutputFormatter({ responseMode: "json", maxBytes: 10_000 });
      const result = formatter.format(true);

      expect(result.text).toBe("true");
    });
  });

  describe("compact-json mode", () => {
    it("formats without whitespace", () => {
      const formatter = new OutputFormatter({ responseMode: "compact-json", maxBytes: 10_000 });
      const result = formatter.format({ hello: "world", nested: { a: 1 } });

      expect(result.text).toBe('{"hello":"world","nested":{"a":1}}');
      expect(result.truncated).toBe(false);
    });

    it("formats arrays compactly", () => {
      const formatter = new OutputFormatter({ responseMode: "compact-json", maxBytes: 10_000 });
      const result = formatter.format([1, 2, 3]);

      expect(result.text).toBe("[1,2,3]");
    });
  });

  describe("yaml mode", () => {
    it("formats objects as YAML", () => {
      const formatter = new OutputFormatter({ responseMode: "yaml", maxBytes: 10_000 });
      const result = formatter.format({ name: "test", value: 123 });

      expect(result.text).toContain("name: test");
      expect(result.text).toContain("value: 123");
      expect(result.truncated).toBe(false);
    });

    it("formats nested objects as YAML", () => {
      const formatter = new OutputFormatter({ responseMode: "yaml", maxBytes: 10_000 });
      const result = formatter.format({ outer: { inner: "value" } });

      expect(result.text).toContain("outer:");
      expect(result.text).toContain("inner: value");
    });

    it("formats arrays as YAML", () => {
      const formatter = new OutputFormatter({ responseMode: "yaml", maxBytes: 10_000 });
      const result = formatter.format({ items: ["a", "b", "c"] });

      expect(result.text).toContain("items:");
      expect(result.text).toContain("- a");
      expect(result.text).toContain("- b");
      expect(result.text).toContain("- c");
    });
  });

  describe("truncation", () => {
    it("truncates output exceeding maxBytes", () => {
      const formatter = new OutputFormatter({ responseMode: "json", maxBytes: 20 });
      const result = formatter.format({ key: "this is a very long value that exceeds the limit" });

      expect(result.truncated).toBe(true);
      expect(result.text).toContain("[truncated");
      expect(result.bytes).toBeGreaterThan(20);
    });

    it("does not truncate when output fits within maxBytes", () => {
      const formatter = new OutputFormatter({ responseMode: "json", maxBytes: 100_000 });
      const result = formatter.format({ small: "data" });

      expect(result.truncated).toBe(false);
      expect(result.text).not.toContain("[truncated");
    });

    it("reports correct original byte count even when truncated", () => {
      const formatter = new OutputFormatter({ responseMode: "json", maxBytes: 10 });
      const data = { message: "hello world this is a longer message" };
      const result = formatter.format(data);

      const expectedFull = JSON.stringify(data, null, 2);
      const expectedBytes = Buffer.byteLength(expectedFull, "utf8");

      expect(result.truncated).toBe(true);
      expect(result.bytes).toBe(expectedBytes);
    });

    it("handles exact boundary correctly", () => {
      const data = { a: 1 };
      const serialized = JSON.stringify(data, null, 2);
      const exactBytes = Buffer.byteLength(serialized, "utf8");

      const formatter = new OutputFormatter({ responseMode: "json", maxBytes: exactBytes });
      const result = formatter.format(data);

      expect(result.truncated).toBe(false);
      expect(result.bytes).toBe(exactBytes);
    });

    it("handles multi-byte characters in truncation", () => {
      const formatter = new OutputFormatter({ responseMode: "json", maxBytes: 30 });
      const result = formatter.format({ emoji: "Hello 🌍🌍🌍🌍🌍" });

      expect(result.truncated).toBe(true);
      expect(result.text).toContain("[truncated");
    });
  });

  describe("edge cases", () => {
    it("handles empty object", () => {
      const formatter = new OutputFormatter({ responseMode: "json", maxBytes: 10_000 });
      const result = formatter.format({});

      expect(result.text).toBe("{}");
      expect(result.truncated).toBe(false);
    });

    it("handles empty array", () => {
      const formatter = new OutputFormatter({ responseMode: "json", maxBytes: 10_000 });
      const result = formatter.format([]);

      expect(result.text).toBe("[]");
      expect(result.truncated).toBe(false);
    });

    it("throws on undefined because JSON.stringify returns undefined", () => {
      const formatter = new OutputFormatter({ responseMode: "json", maxBytes: 10_000 });
      // JSON.stringify(undefined) returns the JS value undefined, which is
      // not a valid argument for Buffer.byteLength.
      expect(() => formatter.format(undefined)).toThrow();
    });

    it("handles deeply nested objects", () => {
      const formatter = new OutputFormatter({ responseMode: "json", maxBytes: 10_000 });
      const deep = { a: { b: { c: { d: { e: "deep" } } } } };
      const result = formatter.format(deep);

      expect(result.text).toContain('"deep"');
      expect(result.truncated).toBe(false);
    });
  });
});
