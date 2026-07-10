import { stringify as toYaml } from "yaml";

export interface FormatOptions {
  responseMode: "json" | "compact-json" | "yaml";
  maxBytes: number;
}

export interface FormattedPayload {
  text: string;
  truncated: boolean;
  bytes: number;
}

export class OutputFormatter {
  constructor(private readonly options: FormatOptions) {}

  format(value: unknown): FormattedPayload {
    const serialized = serializeValue(value, this.options.responseMode);
    const bytes = Buffer.byteLength(serialized, "utf8");

    if (bytes <= this.options.maxBytes) {
      return {
        text: serialized,
        truncated: false,
        bytes
      };
    }

    return {
      text: serializeTruncatedPayload(
        serialized,
        bytes,
        this.options.maxBytes,
        this.options.responseMode
      ),
      truncated: true,
      bytes
    };
  }
}

function serializeTruncatedPayload(
  serialized: string,
  originalBytes: number,
  maxBytes: number,
  mode: FormatOptions["responseMode"]
): string {
  const codePoints = Array.from(serialized);
  let low = 0;
  let high = codePoints.length;
  let best = serializeTruncationMarker("", originalBytes, mode);

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = serializeTruncationMarker(
      codePoints.slice(0, midpoint).join(""),
      originalBytes,
      mode
    );

    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  if (Buffer.byteLength(best, "utf8") <= maxBytes) {
    return best;
  }

  return mode === "yaml" ? "truncated: true\n" : '{"truncated":true}';
}

function serializeTruncationMarker(
  preview: string,
  originalBytes: number,
  mode: FormatOptions["responseMode"]
): string {
  const marker = {
    truncated: true,
    originalBytes,
    preview
  };

  if (mode === "yaml") {
    return toYaml(marker);
  }

  return JSON.stringify(marker, null, mode === "json" ? 2 : undefined);
}

function serializeValue(value: unknown, mode: FormatOptions["responseMode"]): string {
  switch (mode) {
    case "compact-json":
      return JSON.stringify(value);
    case "yaml":
      return toYaml(value);
    case "json":
    default:
      return JSON.stringify(value, null, 2);
  }
}
