import { describe, expect, it } from "vitest";

import {
  attachPaginationMetadata,
  copyPaginationMetadata,
  extractGitLabPaginationMetadata,
  getPaginationMetadata
} from "../src/lib/pagination.js";

describe("GitLab pagination metadata", () => {
  it("extracts numeric headers and RFC Link relations", () => {
    const headers = new Headers({
      "X-Page": "2",
      "X-Next-Page": "3",
      "X-Prev-Page": "1",
      "X-Per-Page": "20",
      "X-Total": "81",
      "X-Total-Pages": "5",
      "X-Next-Page-Token": "cursor-abc123",
      Link: '<https://user:secret@gitlab.example/api/v4/projects?page=3&private_token=hidden>; rel="next", <https://gitlab.example/api/v4/projects?page=1>; rel="prev", <https://gitlab.example/api/v4/projects?page=99>; rel="alternate"'
    });

    expect(extractGitLabPaginationMetadata(headers)).toEqual({
      page: 2,
      next_page: 3,
      prev_page: 1,
      per_page: 20,
      total: 81,
      total_pages: 5,
      next_page_token: "cursor-abc123",
      links: {
        next: 3,
        prev: 1
      }
    });
  });

  it("ignores empty, invalid, oversized, and unsafe pagination values", () => {
    expect(
      extractGitLabPaginationMetadata(
        new Headers({
          "X-Next-Page": "",
          "X-Total": "9007199254740992",
          "X-Next-Page-Token": "x".repeat(1025),
          Link: '<https://gitlab.example/projects?private_token=secret>; rel="next"'
        })
      )
    ).toBeUndefined();
  });

  it("stores metadata without changing serialization and can copy it", () => {
    const source = attachPaginationMetadata([{ id: 1 }], { page: 1, total: 1 });
    const target = copyPaginationMetadata(source, [{ id: 1 }]);

    expect(JSON.stringify(source)).toBe('[{"id":1}]');
    expect(getPaginationMetadata(target)).toEqual({ page: 1, total: 1 });
  });
});
