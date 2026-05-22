import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildContext, createLinkedPair } from "./_helpers.js";

describe("Destructive tool descriptions", () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeAll(async () => {
    const pair = await createLinkedPair(buildContext());
    client = pair.client;
    clientTransport = pair.clientTransport;
    serverTransport = pair.serverTransport;
  });

  afterAll(async () => {
    await clientTransport.close();
    await serverTransport.close();
  });

  it("includes irreversible warnings, identifiers, and pre-check guidance", async () => {
    const { tools } = await client.listTools();
    const descriptions = new Map(tools.map((tool) => [tool.name, tool.description ?? ""]));
    const expectations = [
      {
        name: "gitlab_delete_merge_request_discussion_note",
        identifiers: ["merge_request_iid", "discussion_id", "note_id"]
      },
      {
        name: "gitlab_delete_draft_note",
        identifiers: ["merge_request_iid", "draft_note_id"]
      },
      {
        name: "gitlab_delete_merge_request_note",
        identifiers: ["merge_request_iid", "note_id"]
      },
      {
        name: "gitlab_delete_issue",
        identifiers: ["issue_iid"]
      },
      {
        name: "gitlab_delete_issue_link",
        identifiers: ["issue_iid", "issue_link_id"]
      },
      {
        name: "gitlab_delete_wiki_page",
        identifiers: ["slug"]
      },
      {
        name: "gitlab_delete_milestone",
        identifiers: ["milestone_id"]
      },
      {
        name: "gitlab_delete_release",
        identifiers: ["tag_name"]
      },
      {
        name: "gitlab_delete_tag",
        identifiers: ["tag_name"]
      },
      {
        name: "gitlab_delete_label",
        identifiers: ["name", "label_id"]
      }
    ] as const;

    for (const expectation of expectations) {
      const description = descriptions.get(expectation.name);
      expect(description, `Missing description for ${expectation.name}`).toBeTruthy();
      expect(description).toContain("Irreversible");
      expect(description).toContain("Recommended pre-check");

      for (const identifier of expectation.identifiers) {
        expect(description).toContain(identifier);
      }
    }
  });
});
