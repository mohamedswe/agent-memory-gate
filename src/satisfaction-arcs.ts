/**
 * Satisfaction arcs — deterministic downstream of the classifier. An arc is
 * the once-but-critical signal lane 2 exists for:
 *   - resolved:  displeased -> ... -> pleased   (what failed, and what fixed it)
 *   - unresolved: displeased -> ... -> end      (a failure that survived the session)
 * Pure function over verdicts; no inference, no I/O.
 */
import type { TurnVerdict } from './satisfaction-classifier';

export interface SatisfactionArc {
  kind: 'resolved' | 'unresolved';
  /** index of the first displeased turn */
  fromIndex: number;
  /** index of the pleasing turn (resolved) or the last turn (unresolved) */
  toIndex: number;
}

export function detectArcs(verdicts: TurnVerdict[]): SatisfactionArc[] {
  const arcs: SatisfactionArc[] = [];
  let openFrom: number | null = null;

  for (const turn of verdicts) {
    if (turn.state === 'displeased') {
      if (openFrom === null) openFrom = turn.index;
      // continued displeasure keeps the arc open
    } else if (turn.state === 'pleased' && openFrom !== null) {
      arcs.push({ kind: 'resolved', fromIndex: openFrom, toIndex: turn.index });
      openFrom = null;
    }
    // neutral turns inside an arc change nothing
  }

  if (openFrom !== null) {
    const lastIndex = verdicts.length > 0 ? verdicts[verdicts.length - 1].index : openFrom;
    arcs.push({ kind: 'unresolved', fromIndex: openFrom, toIndex: lastIndex });
  }
  return arcs;
}