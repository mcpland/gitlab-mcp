import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe(".env.example", () => {
  it("documents every environment variable accepted by the schema exactly once", async () => {
    const [source, example] = await Promise.all([
      readFile(new URL("../src/config/env.ts", import.meta.url), "utf8"),
      readFile(new URL("../.env.example", import.meta.url), "utf8")
    ]);
    const schemaBody = source.match(/const envSchema = z\.object\(\{([\s\S]*?)\n\}\);/)?.[1];
    expect(schemaBody).toBeDefined();

    const schemaKeys = [...(schemaBody ?? "").matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map(
      ([, key]) => key
    );
    const exampleKeys = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(([, key]) => key);

    expect(schemaKeys.length).toBeGreaterThan(0);
    expect(exampleKeys.length).toBe(new Set(exampleKeys).size);
    expect(schemaKeys.filter((key) => !exampleKeys.includes(key))).toEqual([]);
  });
});
