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

  it("parses relative upload path with encoded filename", () => {
    expect(parseProjectUploadReference("/uploads/abc123/%E6%B5%8B%E8%AF%95.txt")).toEqual({
      secret: "abc123",
      filename: "测试.txt"
    });
  });

  it("returns undefined for non-upload paths", () => {
    expect(parseProjectUploadReference("/api/v4/projects/1/issues")).toBeUndefined();
  });
});
