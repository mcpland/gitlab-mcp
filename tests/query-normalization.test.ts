import { describe, expect, it } from "vitest";

import {
  ISSUE_ID_USERNAME_PAIRS,
  MERGE_REQUEST_ID_USERNAME_PAIRS,
  normalizeIdUsernameFilters
} from "../src/lib/query-normalization.js";

describe("normalizeIdUsernameFilters", () => {
  it("prefers non-empty issue username filters over IDs", () => {
    expect(
      normalizeIdUsernameFilters(
        {
          author_id: 1,
          author_username: "alice",
          assignee_id: 2,
          assignee_username: ["bob"],
          state: "opened"
        },
        ISSUE_ID_USERNAME_PAIRS
      )
    ).toEqual({
      author_username: "alice",
      assignee_username: ["bob"],
      state: "opened"
    });
  });

  it("retains IDs when username filters are empty", () => {
    expect(
      normalizeIdUsernameFilters(
        {
          author_id: 1,
          author_username: "",
          assignee_id: 2,
          assignee_username: []
        },
        ISSUE_ID_USERNAME_PAIRS
      )
    ).toEqual({
      author_id: 1,
      author_username: "",
      assignee_id: 2,
      assignee_username: []
    });
  });

  it("normalizes reviewer filters for merge requests", () => {
    expect(
      normalizeIdUsernameFilters(
        { reviewer_id: 3, reviewer_username: "carol" },
        MERGE_REQUEST_ID_USERNAME_PAIRS
      )
    ).toEqual({ reviewer_username: "carol" });
  });
});
