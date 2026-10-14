/**
 * Marker records — deterministic rendering of a satisfaction transition into
 * the reviewer-output shape (attempt-kind record content + justification).
 *
 * No inference: the content quotes the user's own turns at the transition
 * boundaries. This is the record the writer then stores through the normal
 * candidate-writer path (project scoping, belongs_to edge, provenance).
 *
 * Kinds:
 *  - milestone:  neutral -> pleased    (completed to satisfaction)
 *  - recovery:   displeased -> pleased (failed then fixed)
 *  - regression: pleased -> displeased (working thing broke)
 *  - unresolved: displeased -> session end (failure survived the session)
 */
import type { SatisfactionTransition } from './satisfaction-transitions';
import type { ReviewerOutput } from './reviewer-output';
import type { UserTurn } from './session-trajectory';

export interface MarkerContext {
  sessionFile: string;
  projectDir: string;
  transition: SatisfactionTransition;
  turns: UserTurn[];
}

const KIND_LABEL: Record<SatisfactionTransition['kind'], string> = {
  milestone: 'milestone reached (user confirmed satisfaction)',
  recovery: 'failure recovered (user displeasure resolved to satisfaction)',
  regression: 'regression (previously-working thing reported broken)',
  unresolved: 'unresolved failure (user displeasure at session end)',
};

function projectNameFor(projectDir: string): string {
  const last = projectDir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? 'unknown';
  return last;
}

/** Quote the user's turns in [fromIndex..toIndex], truncated to fit the budget. */
function quoteTurns(ctx: MarkerContext, budget: number): string {
  const inRange = ctx.turns.filter(t => t.index >= ctx.transition.fromIndex && t.index <= ctx.transition.toIndex);
  const parts: string[] = [];
  let used = 0;
  for (const t of inRange) {
    const remaining = budget - used;
    if (remaining <= 20) break;
    const slice = t.text.slice(0, Math.min(120, remaining - 6)).trim();
    if (!slice) continue;
    const part = `"${slice}"`;
    used += part.length + 2;
    parts.push(part);
  }
  return parts.join(' | ');
}

export function renderMarkerRecord(ctx: MarkerContext): ReviewerOutput {
  const project = projectNameFor(ctx.projectDir);
  const kind = KIND_LABEL[ctx.transition.kind];
  // Content budget: 300 chars total; reserve room for the wrapper.
  const wrapper = `In ${project}: satisfaction ${kind}: `;
  const quoteBudget = 300 - wrapper.length;
  const quoted = quoteTurns(ctx, quoteBudget);
  const content = (wrapper + quoted).slice(0, 300);

  const justification = `Satisfaction transition (${ctx.transition.kind}) at turns ${ctx.transition.fromIndex}-${ctx.transition.toIndex} in ${ctx.sessionFile}`;
  return {
    memory_kind: 'attempt',
    content,
    lifecycle: 'proposed',
    evidence: 'tentative',
    justification: justification.slice(0, 200),
  };
}