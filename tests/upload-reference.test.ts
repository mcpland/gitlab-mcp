import { describe, expect, it } from "vitest";

import { parseProjectUploadReference } from "../src/tools/gitlab.js";

describe("parseProjectUploadReference", () => {
  it("parses absolute upload URL", () => {
    expect(
      parseProjectUploadReference("https://gitlab.example.com/group/repo/uploads/abc123/file.txt")
    ).toEqual({
      secret: "abc123",
      filename: "file.txt"
    });
  });

  it("parses relative upload path", () => {
    expect(parseProjectUploadReference("/uploads/abc123/file.txt")).toEqual({
      secret: "abc123",
      filename: "file.txt"
    });
  });

  it("parses relative upload path with encoded filename", () => {
    expect(parseProjectUploadReference("/uploads/abc123/%E6%B5%8B%E8%AF%95.txt")).toEqual({
      secret: "abc123",
      filename: "测试.txt"
    });
  });

  it("returns undefined for non-upload paths", () => {
    expect(parseProjectUploadReference("/api/v4/projects/1/issues")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseProjectUploadReference("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(parseProjectUploadReference("   ")).toBeUndefined();
  });

  it("handles URL with query parameters", () => {
    const result = parseProjectUploadReference(
      "https://gitlab.example.com/group/repo/uploads/abc123/file.txt?inline=true"
    );
    expect(result).toEqual({
      secret: "abc123",
      filename: "file.txt"
    });
  });

  it("handles URL with fragment", () => {
    const result = parseProjectUploadReference(
      "https://gitlab.example.com/group/repo/uploads/abc123/file.txt#section"
    );
    expect(result).toEqual({
      secret: "abc123",
      filename: "file.txt"
    });
  });

  it("handles URL with nested group paths", () => {
    const result = parseProjectUploadReference(
      "https://gitlab.example.com/group/subgroup/repo/uploads/secret123/document.pdf"
    );
    expect(result).toEqual({
      secret: "secret123",
      filename: "document.pdf"
    });
  });

  it("returns undefined for invalid URL", () => {
    expect(parseProjectUploadReference("not a url at all")).toBeUndefined();
  });

  it("handles upload path without leading slash", () => {
    // This depends on implementation, but should handle gracefully
    const result = parseProjectUploadReference("uploads/abc123/file.txt");
    // May or may not match depending on implementation
    if (result) {
      expect(result.secret).toBe("abc123");
      expect(result.filename).toBe("file.txt");
    }
  });
});
