/**
 * Session trajectory — deterministic, FREE extraction of the user-turn
 * sequence from a Codex rollout for the satisfaction-arc lane (lane 2).
 *
 * Lane 2 design (Mohamed's): repetition capture stays lane 1 (things that
 * repeat are major). Additionally, the USER's reaction to each turn is the
 * salience signal — a displeased->pleased arc marks once-but-critical
 * knowledge that repetition structurally cannot see. Sentiment classification
 * itself is PAID and batched (one call per session, in queue-review); this
 * module only extracts the payload for that call. No inference here.
 *
 * System-injected user-role messages (environment context, AGENTS.md
 * instructions, app-open wrappers, continuation history) are deterministically
 * excluded: they are scaffolding, not the user's voice, and sentiment must
 * never read them.
 */
import { parseRollout } from './rollout-reader';

export interface UserTurn {
  index: number;
  id: string;
  text: string;
}

export interface SessionTrajectory {
  sessionFile: string;
  projectDir: string;
  branch: string | null;
  turns: UserTurn[];
}

/**
 * Deterministic exclusion of system-injected "user" turns. Codex prepends
 * environment context, AGENTS.md instructions, app-open events, and resumed-
 * session history as user-role messages. Shape-matched on the wrapper tags,
 * never content-guessed. Extend as new injection shapes are observed in real
 * rollouts (this list came from live acceptance runs, 2026-10-11).
 */
import { isSystemInjected } from './injection-filter';

function isInjectedUserTurn(text: string): boolean {
  return isSystemInjected(text);
}

/** Extract the ordered user-message sequence from a rollout JSONL string. */
export function extractUserTurns(jsonl: string): Omit<SessionTrajectory, 'sessionFile'> {
  const rollout = parseRollout(jsonl);
  const turns: UserTurn[] = [];
  let index = 0;
  for (const ev of rollout.events) {
    if (ev.kind === 'user_message' && !isInjectedUserTurn(ev.text)) {
      turns.push({ index: index++, id: ev.id, text: ev.text });
    }
  }
  return {
    projectDir: rollout.meta.cwd ?? '',
    branch: rollout.meta.branch,
    turns,
  };
}

export interface SatisfactionJob {
  job: 'satisfaction-trajectory';
  sessionFile: string;
  projectDir: string;
  branch: string | null;
  turns: UserTurn[];
}

/**
 * Build the queue job for the batched satisfaction classifier. Returns null
 * when there are no user turns — a session with zero real user messages gets
 * no paid call (the cheapest failure of all is not making the call).
 */
export function buildSatisfactionJob(sessionFile: string, trajectory: Omit<SessionTrajectory, 'sessionFile'>): SatisfactionJob | null {
  if (trajectory.turns.length === 0) return null;
  return {
    job: 'satisfaction-trajectory',
    sessionFile,
    projectDir: trajectory.projectDir,
    branch: trajectory.branch,
    turns: trajectory.turns,
  };
}