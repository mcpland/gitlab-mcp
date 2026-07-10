import { describe, expect, it } from "vitest";

import { resolveNestedWikiUpdateTitle } from "../src/lib/wiki-title.js";

describe("resolveNestedWikiUpdateTitle", () => {
  it("uses the existing hierarchical title parent", () => {
    expect(
      resolveNestedWikiUpdateTitle(
        "00-map/infra-servers",
        "infra servers v2",
        "00-map/infra servers"
      )
    ).toBe("00-map/infra servers v2");
  });

  it("falls back to the slug parent when the existing title is flat", () => {
    expect(
      resolveNestedWikiUpdateTitle("00-map/infra-servers", "infra servers v2", "infra servers")
    ).toBe("00-map/infra servers v2");
  });

  it("leaves full hierarchical titles and flat slugs unchanged", () => {
    expect(
      resolveNestedWikiUpdateTitle(
        "00-map/infra-servers",
        "new-parent/infra servers",
        "00-map/infra servers"
      )
    ).toBe("new-parent/infra servers");
    expect(resolveNestedWikiUpdateTitle("infra-servers", "infra servers", "Old title")).toBe(
      "infra servers"
    );
  });
});
