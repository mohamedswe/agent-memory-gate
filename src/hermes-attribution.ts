/**
 * Hermes session project attribution — the deterministic answer to "this
 * Hermes chat has no cwd, which project does it belong to?"
 *
 * NO INFERENCE: an operator-curated map (session-id prefix -> project dir)
 * lives in live-run/hermes-project-map.json. Resolution order:
 *   1. a real cwd always wins (observed workspace identity beats curated data)
 *   2. longest session-id prefix match from the map
 *   3. null — honest unknown; the capture layer records "unknown" and the
 *      marker records stay out of any project briefing rather than landing
 *      in a guessed one.
 */

export type ProjectMap = Record<string, string> | null;

export function resolveSessionProject(map: ProjectMap, sessionFile: string, cwd: string | null): string | null {
  if (cwd && cwd.trim()) return cwd;
  if (!map) return null;
  // sessionFile looks like "hermes:20261011_182709_feaab5" — take the id part after the colon
  const id = sessionFile.includes(':') ? sessionFile.split(':')[1] : sessionFile;
  // longest prefix match
  let best: string | null = null;
  let bestLen = 0;
  for (const [prefix, dir] of Object.entries(map)) {
    if (id.startsWith(prefix) && prefix.length > bestLen) {
      best = dir;
      bestLen = prefix.length;
    }
  }
  return best;
}