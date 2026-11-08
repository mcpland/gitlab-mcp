/**
 * MCP initialize instructions.
 */
import { describe, expect, it } from "vitest";

import { buildServerInstructions, MAX_INSTRUCTIONS_BYTES } from "../../src/server/instructions.js";
import { getGitLabToolDefinitions } from "../../src/tools/gitlab.js";
import { buildContext, createLinkedPair } from "./_helpers.js";

describe("server instructions", () => {
  it("are sent to the client during initialize", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(buildContext());
    try {
      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("gitlab_discover_tools");
      expect(instructions).toContain("untrusted data");
      expect(instructions).toContain("Permission mode: full.");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("describe permission mode, project scope, and reduced toolsets", () => {
    const text = buildServerInstructions(
      buildContext({
        permissionMode: "modify",
        allowedProjectIds: ["group/project"],
        toolsets: ["core", "pipelines"]
      })
    );

    expect(text).toContain("Permission mode: modify (delete and teardown tools are hidden).");
    expect(text).toContain("Only these projects are reachable: group/project.");
    expect(text).toContain("Enabled toolsets: core, pipelines.");
  });

  it("stay within the handshake budget and name only registered tools", () => {
    const text = buildServerInstructions(
      buildContext({ allowedProjectIds: Array.from({ length: 50 }, (_, i) => `group/p${i}`) })
    );
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_INSTRUCTIONS_BYTES);

    const registered = new Set(getGitLabToolDefinitions().map((definition) => definition.name));
    for (const name of text.match(/gitlab_[a-z_]+/gu) ?? []) {
      expect(registered.has(name), name).toBe(true);
    }
  });
});
