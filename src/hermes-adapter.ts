/**
 * Hermes adapter — reads the Hermes session store (state.db) as a trajectory
 * source for lane 2. Hermes conversations are where multi-turn satisfaction
 * arcs actually live (Codex usage is one-prompt-per-session).
 *
 * Pure row->turn extraction: no sqlite here (scripts own I/O); tests inject
 * rows. User rows become turns in id order; assistant/tool rows are context,
 * never turns. Hermes has NO system-injected user rows — every user message
 * is the human's actual voice (mid-turn steering included), so unlike the
 * Codex trajectory extractor there is no injection filter here.
 */
export interface HermesMessageRow {
  id: number;
  role: string;
  content: string | null;
  timestamp: number;
}

export interface HermesTrajectory {
  turns: Array<{ index: number; id: string; text: string }>;
}

export function extractHermesTrajectory(rows: HermesMessageRow[]): HermesTrajectory {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const turns: Array<{ index: number; id: string; text: string }> = [];
  for (const row of sorted) {
    if (row.role !== 'user') continue;
    const text = (row.content ?? '').trim();
    if (!text) continue;
    turns.push({ index: turns.length, id: String(row.id), text });
  }
  return { turns };
}