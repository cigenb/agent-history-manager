/** Lower-cased, space-separated search terms; each must appear in the title or in one message. */
export function searchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
}
