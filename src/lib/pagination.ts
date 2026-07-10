const PAGINATION_METADATA = Symbol("gitlab-pagination-metadata");

export interface GitLabPaginationMetadata {
  page?: number;
  next_page?: number;
  prev_page?: number;
  per_page?: number;
  total?: number;
  total_pages?: number;
  next_page_token?: string;
  links?: Partial<Record<PaginationLinkRelation, number>>;
}

type PaginationLinkRelation = "next" | "prev" | "first" | "last";

type MetadataCarrier = object & {
  [PAGINATION_METADATA]?: GitLabPaginationMetadata;
};

export function extractGitLabPaginationMetadata(
  headers: Headers
): GitLabPaginationMetadata | undefined {
  const metadata: GitLabPaginationMetadata = {
    page: parsePaginationInteger(headers.get("x-page")),
    next_page: parsePaginationInteger(headers.get("x-next-page")),
    prev_page: parsePaginationInteger(headers.get("x-prev-page")),
    per_page: parsePaginationInteger(headers.get("x-per-page")),
    total: parsePaginationInteger(headers.get("x-total")),
    total_pages: parsePaginationInteger(headers.get("x-total-pages")),
    next_page_token: parsePaginationToken(headers.get("x-next-page-token"))
  };
  const links = parseLinkHeader(headers.get("link"));
  if (Object.keys(links).length > 0) {
    metadata.links = links;
  }

  return Object.values(metadata).some((value) => value !== undefined) ? metadata : undefined;
}

export function attachPaginationMetadata<T>(
  value: T,
  metadata: GitLabPaginationMetadata | undefined
): T {
  if (!metadata || !isMetadataCarrier(value)) {
    return value;
  }

  Object.defineProperty(value, PAGINATION_METADATA, {
    configurable: true,
    enumerable: false,
    value: metadata
  });
  return value;
}

export function getPaginationMetadata(value: unknown): GitLabPaginationMetadata | undefined {
  if (!isMetadataCarrier(value)) {
    return undefined;
  }
  return value[PAGINATION_METADATA] as GitLabPaginationMetadata | undefined;
}

export function copyPaginationMetadata<T>(source: unknown, target: T): T {
  return attachPaginationMetadata(target, getPaginationMetadata(source));
}

export function copyPaginationMetadataAfterLocalFilter<T>(source: unknown, target: T): T {
  const metadata = getPaginationMetadata(source);
  if (!metadata) {
    return target;
  }

  const safeMetadata = { ...metadata };
  delete safeMetadata.total;
  delete safeMetadata.total_pages;
  delete safeMetadata.links;
  return attachPaginationMetadata(
    target,
    Object.values(safeMetadata).some((value) => value !== undefined) ? safeMetadata : undefined
  );
}

function parsePaginationInteger(value: string | null): number | undefined {
  if (!value || !/^\d+$/u.test(value.trim())) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parsePaginationToken(value: string | null): string | undefined {
  if (!value || value.length > 1024) {
    return undefined;
  }

  return Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x21 && codePoint <= 0x7e;
  })
    ? value
    : undefined;
}

function parseLinkHeader(value: string | null): Partial<Record<PaginationLinkRelation, number>> {
  if (!value) {
    return {};
  }

  const links: Partial<Record<PaginationLinkRelation, number>> = {};
  const matcher = /<([^>]+)>\s*;\s*rel="?([^";,\s]+)"?/gu;
  for (const match of value.matchAll(matcher)) {
    const [, url, relation] = match;
    if (!url || !isPaginationLinkRelation(relation)) {
      continue;
    }

    try {
      const page = parsePaginationInteger(
        new URL(url, "https://gitlab.invalid").searchParams.get("page")
      );
      if (page !== undefined) {
        links[relation] = page;
      }
    } catch {
      // Ignore malformed Link targets and never expose the raw URL.
    }
  }
  return links;
}

function isPaginationLinkRelation(value: string | undefined): value is PaginationLinkRelation {
  return value === "next" || value === "prev" || value === "first" || value === "last";
}

function isMetadataCarrier(value: unknown): value is MetadataCarrier {
  return typeof value === "object" && value !== null;
}
