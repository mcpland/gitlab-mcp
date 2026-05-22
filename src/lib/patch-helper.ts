export interface PatchResult {
  description: string;
  changes: number;
  summary: string;
  preview: string;
}

export interface SearchReplaceBlock {
  search: string;
  replace: string;
}

interface UnifiedHunk {
  oldStart: number;
  lines: string[];
}

export function parseSearchReplaceBlocks(patch: string): SearchReplaceBlock[] {
  const blocks: SearchReplaceBlock[] = [];
  const regex =
    /<<<<<<< SEARCH[^\S\n]*\n([\s\S]*?)=======[^\S\n]*\n([\s\S]*?)>>>>>>> REPLACE[^\S\n]*/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(patch)) !== null) {
    let search = match[1] ?? "";
    let replace = match[2] ?? "";
    if (search.endsWith("\n")) {
      search = search.slice(0, -1);
    }
    if (replace.endsWith("\n")) {
      replace = replace.slice(0, -1);
    }
    blocks.push({ search, replace });
  }

  const searchMarkers = (patch.match(/<<<<<<<\s+SEARCH/g) ?? []).length;
  const replaceMarkers = (patch.match(/>>>>>>>\s+REPLACE/g) ?? []).length;
  if (searchMarkers !== blocks.length || replaceMarkers !== blocks.length) {
    throw new Error(
      `Found ${searchMarkers} SEARCH marker(s) and ${replaceMarkers} REPLACE marker(s), but only parsed ${blocks.length} valid block(s). Each block must follow: <<<<<<< SEARCH\\ntext\\n=======\\nnew text\\n>>>>>>> REPLACE`
    );
  }

  return blocks;
}

export function applySearchReplace(
  source: string,
  blocks: SearchReplaceBlock[],
  allowMultiple = false
): PatchResult {
  let current = source;
  let totalChanges = 0;
  const summary: string[] = [];

  for (const block of blocks) {
    if (block.search.length === 0) {
      throw new Error("Empty SEARCH block is not allowed");
    }

    const regex = new RegExp(escapeRegex(block.search), "g");
    const matches = current.match(regex);
    if (!matches || matches.length === 0) {
      throw new Error(
        `Search text not found in issue description. Search block:\n---\n${truncate(block.search, 200)}\n---`
      );
    }
    if (matches.length > 1 && !allowMultiple) {
      throw new Error(
        `Search text matches ${matches.length} times (expected exactly 1). Use allow_multiple: true to replace all occurrences.`
      );
    }

    const next = current.replace(regex, () => block.replace);
    if (next === current) {
      throw new Error("Replacement did not change the description");
    }

    totalChanges += matches.length;
    summary.push(
      `Replaced ${matches.length} occurrence(s): "${truncate(block.search, 60)}" -> "${truncate(block.replace, 60)}"`
    );
    current = next;
  }

  return {
    description: current,
    changes: totalChanges,
    summary: summary.join("\n"),
    preview: createSimplePreview(source, current)
  };
}

export function applyUnifiedDiff(source: string, patch: string): PatchResult {
  const hunks = parseUnifiedDiffHunks(patch);
  if (hunks.length === 0) {
    throw new Error(
      "Could not parse unified diff: no valid hunks found. Expected headers like @@ -1,2 +1,2 @@"
    );
  }

  const original = splitText(source);
  const lines = [...original.lines];
  let offset = 0;
  let changes = 0;
  const summary: string[] = [];

  for (const hunk of hunks) {
    const index = hunk.oldStart - 1 + offset;
    if (index < 0 || index > lines.length) {
      throw new Error(
        `Unified diff hunk starts outside the issue description at line ${hunk.oldStart}`
      );
    }

    const replacement: string[] = [];
    let consumed = 0;
    let added = 0;
    let removed = 0;

    for (const rawLine of hunk.lines) {
      if (rawLine.startsWith("\\ No newline")) {
        continue;
      }

      const marker = rawLine[0];
      const text = rawLine.slice(1);
      if (marker === " ") {
        assertPatchLine(lines[index + consumed], text, hunk.oldStart + consumed);
        replacement.push(text);
        consumed += 1;
      } else if (marker === "-") {
        assertPatchLine(lines[index + consumed], text, hunk.oldStart + consumed);
        consumed += 1;
        removed += 1;
      } else if (marker === "+") {
        replacement.push(text);
        added += 1;
      } else {
        throw new Error(`Invalid unified diff line: ${rawLine}`);
      }
    }

    lines.splice(index, consumed, ...replacement);
    offset += replacement.length - consumed;
    changes += added + removed;
    summary.push(`Hunk at line ${hunk.oldStart}: ${removed} removed, ${added} added`);
  }

  const description = joinText(lines, original.trailingNewline);
  if (description === source) {
    throw new Error("Unified diff applied but did not change the issue description");
  }

  return {
    description,
    changes,
    summary: summary.join("\n"),
    preview: createSimplePreview(source, description)
  };
}

function parseUnifiedDiffHunks(patch: string): UnifiedHunk[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const hunks: UnifiedHunk[] = [];
  let current: UnifiedHunk | undefined;

  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), lines: [] };
      hunks.push(current);
      continue;
    }

    if (current && (/^[ +\-\\]/.test(line) || line === "")) {
      current.lines.push(line);
    }
  }

  return hunks.filter((hunk) => hunk.lines.length > 0);
}

function assertPatchLine(actual: string | undefined, expected: string, lineNumber: number): void {
  if (actual !== expected) {
    throw new Error(
      `Unified diff context does not match at line ${lineNumber}. Expected "${expected}", got "${actual ?? "<end of text>"}"`
    );
  }
}

function splitText(text: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, trailingNewline };
}

function joinText(lines: string[], trailingNewline: boolean): string {
  const text = lines.join("\n");
  return trailingNewline ? `${text}\n` : text;
}

function createSimplePreview(before: string, after: string): string {
  return `--- current\n+++ updated\n@@\n-${before}\n+${after}`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(str: string, maxLen: number): string {
  return str.length <= maxLen ? str : `${str.slice(0, maxLen)}...`;
}
