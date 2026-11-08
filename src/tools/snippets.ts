import { z } from "zod";

import { encodeGitLabPathSegment } from "../lib/gitlab-path.js";
import { nullableOptional, optionalProjectIdSchema } from "../lib/tool-schema.js";
import type { AppContext } from "../types/context.js";
import {
  deleteCapabilities,
  getOptionalBoolean,
  getOptionalString,
  getString,
  isRecord,
  jsonBody,
  optionalBoolean,
  optionalString,
  paginationShape,
  pickPresentFields,
  projectApiPath,
  readCapabilities,
  resolveProjectId,
  toQuery,
  writeCapabilities,
  type GitLabToolDefinitionInput
} from "./shared.js";

const MAX_SNIPPET_FILES = 10;
const snippetIdSchema = z.coerce.string().min(1);
const snippetFilePathSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.split("/").some((segment) => segment === ".." || segment === "."), {
    message: "file_path must not contain '.' or '..' segments"
  });
const visibilitySchema = z.enum(["private", "internal", "public"]).optional();

export const snippetToolDefinitions: GitLabToolDefinitionInput[] = [
  {
    name: "gitlab_list_project_snippets",
    title: "List Project Snippets",
    description: "List a project's snippets with title, visibility, author, and file names.",
    capabilities: readCapabilities,
    inputSchema: {
      project_id: optionalProjectIdSchema,
      ...paginationShape
    },
    handler: async (args, context) =>
      context.gitlab.get(projectApiPath(resolveProjectId(args, context, true), "snippets"), {
        query: toQuery(pickPresentFields(args, ["page", "per_page"]))
      })
  },
  {
    name: "gitlab_get_project_snippet",
    title: "Get Project Snippet",
    description: `Get a project snippet's metadata. Set include_content=true to also return the raw content of up to ${MAX_SNIPPET_FILES} files; ref overrides the snippet revision.`,
    capabilities: readCapabilities,
    inputSchema: {
      project_id: optionalProjectIdSchema,
      snippet_id: snippetIdSchema,
      include_content: optionalBoolean,
      ref: optionalString
    },
    handler: async (args, context) => {
      const projectId = resolveProjectId(args, context, true);
      const snippetId = getString(args, "snippet_id");
      const snippet = await context.gitlab.get(projectApiPath(projectId, "snippets", snippetId));
      if (getOptionalBoolean(args, "include_content") !== true || !isRecord(snippet)) {
        return snippet;
      }

      return {
        ...snippet,
        files: await readSnippetFiles(
          context,
          projectId,
          snippetId,
          snippet,
          getOptionalString(args, "ref")
        )
      };
    }
  },
  {
    name: "gitlab_create_project_snippet",
    title: "Create Project Snippet",
    description: `Create a project snippet with 1 to ${MAX_SNIPPET_FILES} files. visibility defaults to the project setting; public snippets are visible to anyone who can see the project.`,
    capabilities: writeCapabilities,
    inputSchema: {
      project_id: optionalProjectIdSchema,
      title: z.string().min(1).max(255),
      description: optionalString,
      visibility: visibilitySchema,
      files: z
        .array(z.object({ file_path: snippetFilePathSchema, content: z.string() }))
        .min(1)
        .max(MAX_SNIPPET_FILES)
    },
    handler: async (args, context) =>
      context.gitlab.post(
        projectApiPath(resolveProjectId(args, context, true), "snippets"),
        jsonBody(pickPresentFields(args, ["title", "description", "visibility", "files"]))
      )
  },
  {
    name: "gitlab_update_project_snippet",
    title: "Update Project Snippet",
    description:
      "Update a project snippet's title, description, visibility, or files. Each file change needs action create, update, delete, or move (move requires previous_path).",
    capabilities: writeCapabilities,
    inputSchema: {
      project_id: optionalProjectIdSchema,
      snippet_id: snippetIdSchema,
      title: nullableOptional(z.string().min(1).max(255)),
      description: optionalString,
      visibility: visibilitySchema,
      files: nullableOptional(
        z
          .array(
            z
              .object({
                action: z.enum(["create", "update", "delete", "move"]),
                file_path: snippetFilePathSchema,
                previous_path: nullableOptional(snippetFilePathSchema),
                content: optionalString
              })
              .refine((file) => file.action !== "move" || Boolean(file.previous_path), {
                message: "move requires previous_path"
              })
              .refine(
                (file) =>
                  !(file.action === "create" || file.action === "update") ||
                  typeof file.content === "string",
                { message: "create and update require content" }
              )
          )
          .min(1)
          .max(MAX_SNIPPET_FILES)
      )
    },
    handler: async (args, context) => {
      const payload = pickPresentFields(args, ["title", "description", "visibility", "files"]);
      if (Object.keys(payload).length === 0) {
        throw new Error("Provide at least one snippet field to update");
      }

      return context.gitlab.put(
        projectApiPath(
          resolveProjectId(args, context, true),
          "snippets",
          getString(args, "snippet_id")
        ),
        jsonBody(payload)
      );
    }
  },
  {
    name: "gitlab_delete_project_snippet",
    title: "Delete Project Snippet",
    description:
      "Delete a project snippet and all of its files permanently. Irreversible. Requires snippet_id. Recommended pre-check: gitlab_get_project_snippet.",
    capabilities: deleteCapabilities,
    inputSchema: {
      project_id: optionalProjectIdSchema,
      snippet_id: snippetIdSchema
    },
    handler: async (args, context) => {
      const projectId = resolveProjectId(args, context, true);
      const snippetId = getString(args, "snippet_id");
      await context.gitlab.delete(projectApiPath(projectId, "snippets", snippetId));
      return { status: "deleted", project_id: projectId, snippet_id: snippetId };
    }
  }
];

async function readSnippetFiles(
  context: AppContext,
  projectId: string,
  snippetId: string,
  snippet: Record<string, unknown>,
  refOverride: string | undefined
): Promise<unknown[]> {
  const files = Array.isArray(snippet.files) ? snippet.files.filter(isRecord) : [];
  if (files.length === 0) {
    const content = await context.gitlab.get(
      projectApiPath(projectId, "snippets", snippetId, "raw")
    );
    return [{ path: snippet.file_name ?? null, content }];
  }

  return Promise.all(
    files.slice(0, MAX_SNIPPET_FILES).map(async (file) => {
      const filePath = typeof file.path === "string" ? file.path : undefined;
      if (!filePath) {
        return { ...file, content: null, content_error: "Snippet file has no path" };
      }

      const ref =
        refOverride ??
        (typeof file.raw_url === "string"
          ? extractSnippetRef(file.raw_url, snippetId, filePath)
          : undefined);
      if (!ref) {
        return {
          ...file,
          content: null,
          content_error: "Could not determine the snippet revision"
        };
      }

      const content = await context.gitlab.get(
        `${projectApiPath(projectId, "snippets", snippetId, "files")}/${encodeGitLabPathSegment(
          ref,
          "ref"
        )}/${encodeGitLabPathSegment(filePath, "file_path")}/raw`
      );
      return { ...file, content };
    })
  );
}

/**
 * Snippet files carry a raw_url such as
 * https://gitlab.example.com/group/project/-/snippets/7/raw/main/src/app.rb;
 * the revision is everything between "/snippets/<id>/raw/" and the file path.
 */
export function extractSnippetRef(
  rawUrl: string,
  snippetId: string,
  filePath: string
): string | undefined {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(rawUrl).pathname);
  } catch {
    return undefined;
  }

  const marker = `/snippets/${snippetId}/raw/`;
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex === -1) {
    return undefined;
  }

  const afterMarker = pathname.slice(markerIndex + marker.length);
  const suffix = `/${filePath}`;
  if (!afterMarker.endsWith(suffix)) {
    return undefined;
  }

  const ref = afterMarker.slice(0, afterMarker.length - suffix.length);
  return ref.length > 0 ? ref : undefined;
}
