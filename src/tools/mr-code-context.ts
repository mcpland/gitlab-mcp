import picomatch from "picomatch";
import { z } from "zod";

import type { AppContext } from "../types/context.js";

export const mergeRequestCodeContextSchema = {
  project_id: z.string().optional(),
  merge_request_iid: z.string().min(1),
  include_paths: z.array(z.string()).optional(),
  exclude_paths: z.array(z.string()).optional(),
  extensions: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  max_files: z.number().int().min(1).max(500).default(30),
  max_total_chars: z.number().int().min(500).max(2_000_000).default(120_000),
  context_lines: z.number().int().min(0).max(200).default(20),
  mode: z.enum(["patch", "surrounding", "fullfile"]).default("patch"),
  sort: z.enum(["changed_lines", "path", "file_size"]).default("changed_lines"),
  list_only: z.boolean().default(false)
} as const;

interface MergeRequestInfo {
  source_branch?: string;
  target_branch?: string;
}

interface DiffFile {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
}

interface Budget {
  maxChars: number;
  usedChars: number;
}

export async function getMergeRequestCodeContext(
  args: {
    projectId: string;
    mergeRequestIid: string;
    includePaths?: string[];
    excludePaths?: string[];
    extensions?: string[];
    languages?: string[];
    maxFiles: number;
    maxTotalChars: number;
    contextLines: number;
    mode: "patch" | "surrounding" | "fullfile";
    sort: "changed_lines" | "path" | "file_size";
    listOnly: boolean;
  },
  context: AppContext
): Promise<Record<string, unknown>> {
  const mergeRequest = (await context.gitlab.getMergeRequest(
    args.projectId,
    args.mergeRequestIid
  )) as MergeRequestInfo;
  const diffResponse = await context.gitlab.getMergeRequestDiffs(
    args.projectId,
    args.mergeRequestIid
  );
  const diffFiles = extractDiffFiles(diffResponse);

  const filtered = filterDiffFiles(diffFiles, {
    includePaths: args.includePaths,
    excludePaths: args.excludePaths,
    extensions: args.extensions,
    languages: args.languages
  });

  const sorted = sortDiffFiles(filtered, args.sort);
  const selected = sorted.slice(0, args.maxFiles);

  if (args.listOnly) {
    return {
      project_id: args.projectId,
      merge_request_iid: args.mergeRequestIid,
      mode: args.mode,
      list_only: true,
      total_files: diffFiles.length,
      selected_files: selected.length,
      files: selected.map((file) => summarizeFile(file))
    };
  }

  const ref = mergeRequest.source_branch ?? "main";
  const budget: Budget = {
    maxChars: args.maxTotalChars,
    usedChars: 0
  };

  const files: Array<Record<string, unknown>> = [];

  for (const file of selected) {
    const item = await buildFilePayload(file, {
      mode: args.mode,
      contextLines: args.contextLines,
      projectId: args.projectId,
      ref,
      gitlab: context.gitlab,
      budget
    });

    if (item) {
      files.push(item);
    }

    if (budget.usedChars >= budget.maxChars) {
      break;
    }
  }

  return {
    project_id: args.projectId,
    merge_request_iid: args.mergeRequestIid,
    source_branch: mergeRequest.source_branch,
    target_branch: mergeRequest.target_branch,
    mode: args.mode,
    total_files: diffFiles.length,
    filtered_files: filtered.length,
    selected_files: selected.length,
    returned_files: files.length,
    budget: {
      max_total_chars: budget.maxChars,
      used_chars: budget.usedChars,
      remaining_chars: Math.max(0, budget.maxChars - budget.usedChars)
    },
    files
  };
}

function extractDiffFiles(response: unknown): DiffFile[] {
  if (Array.isArray(response)) {
    return response as DiffFile[];
  }

  if (typeof response === "object" && response !== null) {
    const record = response as Record<string, unknown>;
    if (Array.isArray(record.changes)) {
      return record.changes as DiffFile[];
    }
    if (Array.isArray(record.diffs)) {
      return record.diffs as DiffFile[];
    }
  }

  return [];
}

function filterDiffFiles(
  files: DiffFile[],
  options: {
    includePaths?: string[];
    excludePaths?: string[];
    extensions?: string[];
    languages?: string[];
  }
): DiffFile[] {
  const includeMatchers = (options.includePaths ?? []).map((pattern) => picomatch(pattern));
  const excludeMatchers = (options.excludePaths ?? []).map((pattern) => picomatch(pattern));
  const extensionSet = new Set((options.extensions ?? []).map((item) => normalizeExtension(item)));
  const languageExtSet = new Set(
    (options.languages ?? []).flatMap((language) => languageToExtensions(language.toLowerCase()))
  );

  return files.filter((file) => {
    const path = file.new_path || file.old_path;

    if (includeMatchers.length > 0 && !includeMatchers.some((matcher) => matcher(path))) {
      return false;
    }

    if (excludeMatchers.some((matcher) => matcher(path))) {
      return false;
    }

    const extension = extractExtension(path);

    if (extensionSet.size > 0 && !extensionSet.has(extension)) {
      return false;
    }

    if (languageExtSet.size > 0 && !languageExtSet.has(extension)) {
      return false;
    }

    return true;
  });
}

function sortDiffFiles(
  files: DiffFile[],
  sortMode: "changed_lines" | "path" | "file_size"
): DiffFile[] {
  const cloned = [...files];

  switch (sortMode) {
    case "path":
      cloned.sort((a, b) => (a.new_path || a.old_path).localeCompare(b.new_path || b.old_path));
      return cloned;
    case "file_size":
      cloned.sort((a, b) => (b.diff?.length ?? 0) - (a.diff?.length ?? 0));
      return cloned;
    case "changed_lines":
    default:
      cloned.sort((a, b) => countChangedLines(b.diff) - countChangedLines(a.diff));
      return cloned;
  }
}

async function buildFilePayload(
  file: DiffFile,
  options: {
    mode: "patch" | "surrounding" | "fullfile";
    contextLines: number;
    projectId: string;
    ref: string;
    gitlab: AppContext["gitlab"];
    budget: Budget;
  }
): Promise<Record<string, unknown> | undefined> {
  const summary = summarizeFile(file);

  if (options.mode === "patch" || file.deleted_file) {
    const taken = takeWithinBudget(file.diff ?? "", options.budget);
    return {
      ...summary,
      content: taken.value,
      content_mode: "patch",
      truncated: taken.truncated
    };
  }

  const rawFile = (await options.gitlab.getFileContents(
    options.projectId,
    file.new_path,
    options.ref
  )) as Record<string, unknown>;
  const decoded = decodeGitLabFileContent(rawFile);

  if (options.mode === "fullfile") {
    const taken = takeWithinBudget(decoded, options.budget);
    return {
      ...summary,
      content: taken.value,
      content_mode: "fullfile",
      truncated: taken.truncated
    };
  }

  const changedLines = extractChangedNewLines(file.diff ?? "");
  const snippets = extractSurroundingSnippets(decoded, changedLines, options.contextLines);
  const payload = snippets
    .map((snippet) => `@@ ${snippet.start}-${snippet.end} @@\n${snippet.content}`)
    .join("\n\n");
  const taken = takeWithinBudget(payload, options.budget);

  return {
    ...summary,
    content: taken.value,
    content_mode: "surrounding",
    snippet_windows: snippets.map((item) => ({ start: item.start, end: item.end })),
    truncated: taken.truncated
  };
}

function summarizeFile(file: DiffFile): Record<string, unknown> {
  return {
    old_path: file.old_path,
    new_path: file.new_path,
    new_file: file.new_file,
    renamed_file: file.renamed_file,
    deleted_file: file.deleted_file,
    changed_lines: countChangedLines(file.diff)
  };
}

function countChangedLines(diff: string | undefined): number {
  if (!diff) {
    return 0;
  }

  let count = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      count += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      count += 1;
    }
  }

  return count;
}

function extractChangedNewLines(diff: string): number[] {
  const lines = diff.split("\n");
  const changed = new Set<number>();
  let currentNewLine = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = /\+([0-9]+)(?:,([0-9]+))?/.exec(line);
      if (match?.[1]) {
        currentNewLine = Number.parseInt(match[1], 10);
      }
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      changed.add(currentNewLine);
      currentNewLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }

    currentNewLine += 1;
  }

  return [...changed].sort((a, b) => a - b);
}

function extractSurroundingSnippets(
  source: string,
  changedLines: number[],
  contextLines: number
): Array<{ start: number; end: number; content: string }> {
  const sourceLines = source.split("\n");

  if (changedLines.length === 0) {
    return [
      {
        start: 1,
        end: Math.min(sourceLines.length, contextLines * 2 + 1),
        content: sourceLines.slice(0, Math.min(sourceLines.length, contextLines * 2 + 1)).join("\n")
      }
    ];
  }

  const windows = mergeWindows(
    changedLines.map((lineNumber) => ({
      start: Math.max(1, lineNumber - contextLines),
      end: Math.min(sourceLines.length, lineNumber + contextLines)
    }))
  );

  return windows.map((window) => ({
    start: window.start,
    end: window.end,
    content: sourceLines.slice(window.start - 1, window.end).join("\n")
  }));
}

function mergeWindows(
  windows: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
  if (windows.length === 0) {
    return [];
  }

  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const first = sorted[0];
  if (!first) {
    return [];
  }

  const merged: Array<{ start: number; end: number }> = [first];

  for (const window of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(window);
      continue;
    }

    if (window.start <= last.end + 1) {
      last.end = Math.max(last.end, window.end);
      continue;
    }

    merged.push(window);
  }

  return merged;
}

function decodeGitLabFileContent(raw: Record<string, unknown>): string {
  const content = typeof raw.content === "string" ? raw.content : "";
  const encoding = typeof raw.encoding === "string" ? raw.encoding.toLowerCase() : "";

  if (encoding === "base64") {
    return Buffer.from(content, "base64").toString("utf8");
  }

  return content;
}

function takeWithinBudget(value: string, budget: Budget): { value: string; truncated: boolean } {
  const remaining = Math.max(0, budget.maxChars - budget.usedChars);

  if (remaining <= 0) {
    return {
      value: "",
      truncated: true
    };
  }

  if (value.length <= remaining) {
    budget.usedChars += value.length;
    return {
      value,
      truncated: false
    };
  }

  budget.usedChars = budget.maxChars;
  return {
    value: `${value.slice(0, remaining)}\n... [truncated]`,
    truncated: true
  };
}

function normalizeExtension(extension: string): string {
  const cleaned = extension.trim().toLowerCase();
  if (cleaned.length === 0) {
    return "";
  }

  return cleaned.startsWith(".") ? cleaned : `.${cleaned}`;
}

function extractExtension(path: string): string {
  const match = /\.([^./]+)$/.exec(path.toLowerCase());
  if (!match?.[1]) {
    return "";
  }

  return `.${match[1]}`;
}

function languageToExtensions(language: string): string[] {
  const map: Record<string, string[]> = {
    typescript: [".ts", ".tsx", ".mts", ".cts"],
    javascript: [".js", ".jsx", ".mjs", ".cjs"],
    python: [".py"],
    go: [".go"],
    rust: [".rs"],
    java: [".java"],
    kotlin: [".kt", ".kts"],
    csharp: [".cs"],
    cpp: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    c: [".c", ".h"],
    ruby: [".rb"],
    php: [".php"],
    swift: [".swift"],
    scala: [".scala"],
    shell: [".sh", ".bash", ".zsh"],
    yaml: [".yaml", ".yml"],
    json: [".json"],
    markdown: [".md", ".markdown"]
  };

  return map[language] ?? [];
}
