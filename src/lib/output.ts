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

    const buffer = Buffer.from(serialized, "utf8");
    const head = buffer.subarray(0, this.options.maxBytes);
    const truncatedBytes = bytes - this.options.maxBytes;

    return {
      text: `${head.toString("utf8")}\n... [truncated ${truncatedBytes} bytes]`,
      truncated: true,
      bytes
    };
  }
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
