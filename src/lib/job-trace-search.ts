/**
 * Substring search over a CI job trace. Matching is plain substring
 * comparison (no regular expressions), so a caller-supplied pattern cannot
 * trigger catastrophic backtracking on a megabyte-sized log.
 */

export interface JobTraceSearchOptions {
  patterns: string[];
  caseSensitive?: boolean;
  contextLines?: number;
  maxMatches?: number;
}

export interface JobTraceSearchResult {
  totalMatches: number;
  returnedMatches: number;
  truncated: boolean;
  text: string;
}

export const DEFAULT_JOB_TRACE_CONTEXT_LINES = 3;
export const MAX_JOB_TRACE_CONTEXT_LINES = 20;
export const DEFAULT_JOB_TRACE_MAX_MATCHES = 20;
export const MAX_JOB_TRACE_MAX_MATCHES = 100;

// ANSI CSI sequences (colors, erase-line) and GitLab collapsible-section markers
// such as "section_start:1700000000:step_script[collapsed=true]\r".
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
const SECTION_MARKER_PATTERN = /section_(?:start|end):\d+:[A-Za-z0-9_.-]+(?:\[[^\]\r\n]*\])?\r?/gu;

/** Remove terminal escapes, section markers, and carriage returns from one log line. */
export function cleanJobTraceLine(line: string): string {
  return line
    .replace(SECTION_MARKER_PATTERN, "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\r/gu, "");
}

export function searchJobTrace(
  trace: string,
  options: JobTraceSearchOptions
): JobTraceSearchResult {
  const caseSensitive = options.caseSensitive === true;
  const patterns = options.patterns
    .filter((pattern) => pattern.length > 0)
    .map((pattern) => (caseSensitive ? pattern : pattern.toLowerCase()));
  const contextLines = clamp(
    options.contextLines ?? DEFAULT_JOB_TRACE_CONTEXT_LINES,
    0,
    MAX_JOB_TRACE_CONTEXT_LINES
  );
  const maxMatches = clamp(
    options.maxMatches ?? DEFAULT_JOB_TRACE_MAX_MATCHES,
    1,
    MAX_JOB_TRACE_MAX_MATCHES
  );

  const lines = trace.split("\n").map(cleanJobTraceLine);
  const matchIndexes: number[] = [];
  let totalMatches = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const haystack = caseSensitive ? lines[index]! : lines[index]!.toLowerCase();
    if (patterns.some((pattern) => haystack.includes(pattern))) {
      totalMatches += 1;
      if (matchIndexes.length < maxMatches) {
        matchIndexes.push(index);
      }
    }
  }

  const windows: Array<{ start: number; end: number }> = [];
  for (const index of matchIndexes) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length - 1, index + contextLines);
    const previous = windows.at(-1);
    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
    } else {
      windows.push({ start, end });
    }
  }

  const matched = new Set(matchIndexes);
  const width = String(lines.length).length;
  const blocks = windows.map(({ start, end }) => {
    const body = lines
      .slice(start, end + 1)
      .map((line, offset) => {
        const lineNumber = start + offset;
        const marker = matched.has(lineNumber) ? ">" : " ";
        return `${marker}${String(lineNumber + 1).padStart(width)}: ${line}`;
      })
      .join("\n");
    return `--- lines ${start + 1}-${end + 1} of ${lines.length} ---\n${body}`;
  });

  return {
    totalMatches,
    returnedMatches: matchIndexes.length,
    truncated: totalMatches > matchIndexes.length,
    text: blocks.join("\n\n")
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
