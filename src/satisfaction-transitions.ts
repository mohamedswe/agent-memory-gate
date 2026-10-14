/**
 * Satisfaction transitions — deterministic downstream of the classifier.
 * Three marker types, each a distinct once-but-critical signal:
 *   milestone:  neutral -> pleased   (task completed to the user's satisfaction)
 *   recovery:   displeased -> pleased (something failed, then got fixed)
 *   regression: pleased -> displeased (something that worked broke)
 * A displeased run that never resolves by session end is reported as
 * `unresolved` (the highest-value capture: a failure that survived).
 *
 * Pure function over verdicts; no inference, no I/O.
 */
import type { TurnVerdict } from './satisfaction-classifier';

export type TransitionKind = 'milestone' | 'recovery' | 'regression' | 'unresolved';

export interface SatisfactionTransition {
  kind: TransitionKind;
  /** index of the turn BEFORE the state change (or first displeased turn for unresolved) */
  fromIndex: number;
  /** index of the turn where the new state is observed */
  toIndex: number;
}

export function detectTransitions(verdicts: TurnVerdict[]): SatisfactionTransition[] {
  const transitions: SatisfactionTransition[] = [];
  const openDispleasedFrom: number | null = null; // handled below via loop state

  let prev: TurnVerdict | null = null;
  let displeasedFrom: number | null = null; // index of the FIRST displeased turn of the open run

  for (const turn of verdicts) {
    if (turn.state === 'displeased' && displeasedFrom === null) {
      displeasedFrom = turn.index; // a displeased run starts (kept at its first turn)
    }
    if (prev !== null && turn.state !== prev.state) {
      if (turn.state === 'pleased') {
        if (prev.state === 'neutral') {
          transitions.push({ kind: 'milestone', fromIndex: prev.index, toIndex: turn.index });
        } else if (prev.state === 'displeased') {
          // recovery closes the OPEN RUN — report it from the run's start, not the last displeased turn
          transitions.push({ kind: 'recovery', fromIndex: displeasedFrom ?? prev.index, toIndex: turn.index });
          displeasedFrom = null;
        }
      } else if (turn.state === 'displeased') {
        if (prev.state === 'pleased') {
          transitions.push({ kind: 'regression', fromIndex: prev.index, toIndex: turn.index });
        }
        // displeasedFrom already set above at run start; never overwrite mid-run
      }
    }
    prev = turn;
  }

  if (displeasedFrom !== null) {
    const lastIndex = verdicts.length > 0 ? verdicts[verdicts.length - 1].index : displeasedFrom;
    transitions.push({ kind: 'unresolved', fromIndex: displeasedFrom, toIndex: lastIndex });
  }
  return transitions;
}