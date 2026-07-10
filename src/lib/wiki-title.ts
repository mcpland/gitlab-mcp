/** Preserve a nested wiki hierarchy when an update supplies only a new leaf title. */
export function resolveNestedWikiUpdateTitle(
  slug: string,
  providedTitle: string,
  existingTitle: string
): string {
  if (providedTitle.includes("/") || !slug.includes("/")) {
    return providedTitle;
  }

  const existingParentIndex = existingTitle.lastIndexOf("/");
  if (existingParentIndex >= 0) {
    return `${existingTitle.slice(0, existingParentIndex)}/${providedTitle}`;
  }

  const slugParentIndex = slug.lastIndexOf("/");
  return slugParentIndex >= 0
    ? `${slug.slice(0, slugParentIndex)}/${providedTitle}`
    : providedTitle;
}
