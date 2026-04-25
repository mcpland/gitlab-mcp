import { z } from "zod";

const NO_ASCII_CONTROL_CHARS = new RegExp(String.raw`^[^\u0000-\u001F\u007F]+$`, "u");
const NO_NULL_BYTES = new RegExp(String.raw`^[^\u0000]*$`, "u");
const REF_LIKE_PATTERN = new RegExp(
  String.raw`^(?!/)(?!.*//)(?!.*(?:^|/)\.)(?!.*/$)(?!.*\.$)(?!.*\.lock$)(?!.*(?:\.\.|@\{))[^\u0000-\u001F\u007F ~^:?*\[\\]+$`,
  "u"
);
const SLUG_PATTERN = new RegExp(
  String.raw`^(?!/)(?!.*//)(?!.*(?:^|/)\.\.?(?:/|$))(?!.*[?#])[^\u0000-\u001F\u007F]+$`,
  "u"
);
const PATH_LIKE_PATTERN = new RegExp(
  String.raw`^(?![A-Za-z][A-Za-z0-9+.-]*:)(?!//)[^\u0000-\u001F\u007F]+$`,
  "u"
);

export function nullableOptional<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullable().optional();
}

export const projectIdSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(NO_ASCII_CONTROL_CHARS, "project_id must not contain ASCII control characters");

export const optionalProjectIdSchema = nullableOptional(projectIdSchema);

export const refLikeSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(REF_LIKE_PATTERN, "must be a valid Git ref-like name");

export const optionalRefLikeSchema = nullableOptional(refLikeSchema);

export const slugSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(
    SLUG_PATTERN,
    "slug must be a path-like value without control characters, dot segments, ?, or #"
  );

export const optionalSlugSchema = nullableOptional(slugSchema);

export const displayNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(NO_ASCII_CONTROL_CHARS, "must not contain ASCII control characters");

export const optionalDisplayNameSchema = nullableOptional(displayNameSchema);

export const bodySchema = z
  .string()
  .min(1)
  .max(1_000_000)
  .regex(NO_NULL_BYTES, "body must not contain null bytes");

export const optionalBodySchema = nullableOptional(bodySchema);

const absoluteHttpUrlSchema = z
  .string()
  .url()
  .max(4096)
  .regex(/^https?:\/\/.*$/u, "url_or_path must use http or https when an absolute URL is provided");

const pathLikeSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(PATH_LIKE_PATTERN, "url_or_path must be a relative path or an absolute http(s) URL");

export const urlOrPathSchema = z.union([absoluteHttpUrlSchema, pathLikeSchema]);

export const optionalUrlOrPathSchema = nullableOptional(urlOrPathSchema);
