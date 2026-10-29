/**
 * Repeated-correction census — pure functions. Deterministic, no inference,
 * no file I/O (scripts/correction-census.ts owns all reads and writes).
 *
 * Question: how often does the user have to repeat the same correction across
 * sessions, and how often across PROJECTS? Cross-project repeats are the
 * user-level (personalization) signal that the cross-session ledger
 * deliberately discards as "generic habit".
 *
 * Everything here is deliberately coarse. Precision of the detector is meant
 * to be measured by hand-labelling the sample file, not assumed.
 */
import { parseRollout } from './rollout-reader';
import { isSystemInjected } from './injection-filter';
import { projectSlugFor } from './project-registry';

export type Source = 'codex' | 'claude-code' | 'hermes';

/** One conversational turn. 'agent' covers assistant text AND tool calls/results. */
export interface Turn {
  role: 'user' | 'agent';
  text: string;
}

export interface SessionTurns {
  source: Source;
  sessionId: string;
  /** Stable project slug (projects/<name>) or 'unknown'. */
  project: string;
  /** Epoch ms used to order sessions; 0 when unknown. */
  startedAt: number;
  turns: Turn[];
}

export const UNKNOWN_PROJECT = 'unknown';

export function projectFor(cwd: string | null | undefined): string {
  return cwd && cwd.trim() ? projectSlugFor(cwd) : UNKNOWN_PROJECT;
}

function toMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Hermes stores unix seconds (possibly fractional); anything this small is seconds.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value) {
    const n = Date.parse(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

// ---------------------------------------------------------------- extraction

/** Codex rollout JSONL -> turns. Reuses parseRollout; drops system-injected "user" content. */
export function codexSessionTurns(jsonl: string, fallbackId: string): SessionTurns {
  const rollout = parseRollout(jsonl);
  let startedAt = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { timestamp?: unknown; payload?: { timestamp?: unknown } };
      startedAt = toMs(parsed.payload?.timestamp) || toMs(parsed.timestamp);
    } catch { /* partial line */ }
    if (startedAt) break;
  }
  const turns: Turn[] = [];
  for (const ev of rollout.events) {
    if (ev.kind === 'user_message') {
      const text = ev.text.trim();
      if (text && !isSystemInjected(text)) turns.push({ role: 'user', text });
    } else if (ev.kind === 'assistant_message') {
      if (ev.text.trim()) turns.push({ role: 'agent', text: ev.text.trim() });
    } else if (ev.kind === 'tool_call') {
      turns.push({ role: 'agent', text: `[tool ${ev.name}] ${JSON.stringify(ev.args)}` });
    }
    // tool_output: the call already marks the agent turn; outputs add no adjacency info.
  }
  return {
    source: 'codex',
    sessionId: rollout.meta.sessionId || fallbackId,
    project: projectFor(rollout.meta.cwd),
    startedAt,
    turns,
  };
}

/**
 * Claude Code injects harness text as user-role content: slash-command
 * wrappers, local command output, interrupt markers, system reminders,
 * the "Caveat:" preamble, and compaction summaries. None of it is the user's voice.
 */
const CLAUDE_INJECTED = [
  /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|user-memory-input|bash-input|bash-stdout|bash-stderr)/,
  /^\[Request interrupted by user/,
  /^Caveat: The messages below were generated/,
  /^This session is being continued from a previous conversation/,
];

export function isClaudeCodeInjected(text: string): boolean {
  const t = text.trimStart();
  return isSystemInjected(t) || CLAUDE_INJECTED.some(re => re.test(t));
}

/** Claude Code main-session transcript JSONL -> turns (user TEXT only; tool_results are agent context). */
export function claudeCodeSessionTurns(jsonl: string, fallbackId: string): SessionTurns {
  let sessionId = '';
  let cwd: string | null = null;
  let startedAt = 0;
  const seen = new Set<string>();
  const turns: Turn[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type !== 'user' && ev?.type !== 'assistant') continue;
    if (ev.isSidechain === true || ev.isMeta === true) continue;
    if (typeof ev.uuid === 'string') {
      if (seen.has(ev.uuid)) continue; // resumed sessions can replay lines
      seen.add(ev.uuid);
    }
    sessionId ||= typeof ev.sessionId === 'string' ? ev.sessionId : '';
    cwd ??= typeof ev.cwd === 'string' ? ev.cwd : null;
    startedAt ||= toMs(ev.timestamp);
    const content = ev.message?.content;
    const parts: any[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const c of parts) {
      if (ev.type === 'user' && c?.type === 'text' && typeof c.text === 'string') {
        const text = c.text.trim();
        if (text && !isClaudeCodeInjected(text)) turns.push({ role: 'user', text });
      } else if (ev.type === 'user' && c?.type === 'tool_result') {
        turns.push({ role: 'agent', text: '[tool result]' });
      } else if (ev.type === 'assistant' && c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        turns.push({ role: 'agent', text: c.text.trim() });
      } else if (ev.type === 'assistant' && c?.type === 'tool_use') {
        turns.push({ role: 'agent', text: `[tool ${c.name}] ${JSON.stringify(c.input ?? {})}` });
      }
    }
  }
  return { source: 'claude-code', sessionId: sessionId || fallbackId, project: projectFor(cwd), startedAt, turns };
}

export interface HermesRow {
  id: number;
  role: string;
  content: string | null;
}

/** Hermes rows for ONE session -> turns, in id order. Non-user roles are agent context. */
export function hermesSessionTurns(sessionId: string, project: string, startedAt: unknown, rows: HermesRow[]): SessionTurns {
  const turns: Turn[] = [];
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    const text = (row.content ?? '').trim();
    if (row.role === 'user') { if (text) turns.push({ role: 'user', text }); }
    else if (row.role !== 'system') turns.push({ role: 'agent', text: text || `[${row.role}]` });
  }
  return { source: 'hermes', sessionId, project, startedAt: toMs(startedAt), turns };
}

// ----------------------------------------------------------------- detection

/** "Short-ish": longer messages are usually new task specs, not pushback. */
export const MAX_CORRECTION_CHARS = 280;
export const MAX_CORRECTION_WORDS = 45;

/** Must START the message (after optional "ok,"/"hmm,"-style lead-ins are NOT stripped: kept coarse). */
const STARTS = /^(no\b|nope\b|nah\b|stop\b|wrong\b|that'?s\b|thats\b|actually\b|use\b|instead\b|revert\b|undo\b|remove\b|change\b|not\b|why\b|fix\b|don'?t\b|do not\b)/;
/** May appear ANYWHERE. Narrower than STARTS: "use"/"fix"/"change"/"not"/"why" mid-sentence are too common. */
const CONTAINS = /\b(don'?t|do not|stop|wrong|instead|revert|undo|not what i|i said|i told you|again\?)\b/;

/**
 * A correction is a short user message matching a pushback pattern that comes
 * right after an agent turn (assistant text or tool activity) in the same session.
 * Coarse by design: "use X" or "fix the tests" after an agent turn may just be
 * the next instruction. The hand-label sample measures how often that happens.
 */
export function isCorrection(text: string, precededByAgent: boolean): boolean {
  if (!precededByAgent) return false;
  const t = text.trim().toLowerCase().replace(/[‘’]/g, "'");
  if (!t || t.length > MAX_CORRECTION_CHARS) return false;
  if (t.split(/\s+/).length > MAX_CORRECTION_WORDS) return false;
  return STARTS.test(t) || CONTAINS.test(t);
}

/** Leading filler dropped from signatures; applied repeatedly ("no, just, please use X" -> "use x"). */
const LEADING_FILLER = new Set(['no', 'nope', 'nah', 'dont', 'please', 'just', 'actually', 'stop', 'ok', 'okay', 'hey', 'so']);
const TRAILING_FILLER = new Set(['please', 'thanks', 'thx', 'ty']);

/**
 * Deterministic signature for matching the "same" correction across sessions.
 *
 * LOSSY, on purpose (first pass, no fuzzy matching):
 *  - Dropping leading "dont" flips meaning: "don't add comments" and "add
 *    comments" collide. Kept because the brief asks for it; check the sample.
 *  - Stripping punctuation merges code tokens: "bun scripts/test.ts" becomes
 *    "bun scripts test ts". Paths and commands lose their separators.
 *  - Paraphrases ("no comments" vs "stop adding comments") never match.
 *  - Emoji and all non-ASCII symbols are removed; non-Latin letters are kept.
 */
export function correctionSignature(text: string): string {
  let s = text.toLowerCase()
    .replace(/[‘’']/g, '')             // don't -> dont (before punctuation becomes space)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')           // punctuation, emoji, symbols -> space
    .replace(/\s+/g, ' ')
    .trim();
  let words = s ? s.split(' ') : [];
  // "do not" counts as one leading filler, like "dont".
  for (;;) {
    if (words[0] === 'do' && words[1] === 'not') { words = words.slice(2); continue; }
    if (words.length && LEADING_FILLER.has(words[0])) { words = words.slice(1); continue; }
    break;
  }
  while (words.length && TRAILING_FILLER.has(words[words.length - 1])) words.pop();
  if (words.length >= 2 && words[words.length - 2] === 'thank' && words[words.length - 1] === 'you') words = words.slice(0, -2);
  s = words.join(' ');
  return s;
}

/**
 * Signatures under this many words ("no", "stop", "revert", "why") carry no
 * content about WHAT was wrong; they repeat everywhere and would swamp the
 * metric. They still count as correction events, but never as repeats.
 * Same threshold as the usage ledger's MIN_PROMOTABLE_WORDS.
 */
export const MIN_SIGNATURE_WORDS = 2;

export function isMatchableSignature(signature: string): boolean {
  return signature.split(' ').filter(Boolean).length >= MIN_SIGNATURE_WORDS;
}

// -------------------------------------------------------------------- census

export interface CorrectionEvent {
  source: Source;
  sessionId: string;
  project: string;
  startedAt: number;
  turnIndex: number;
  text: string;
  signature: string;
  matchable: boolean;
  /** Up to 2 preceding turns, oldest first. */
  context: Turn[];
  /** Same signature earlier in THIS session. */
  withinSessionRepeat: boolean;
  /** Same signature in a strictly earlier session (any project). Headline numerator. */
  repeat: boolean;
  /** ...and at least one of those earlier sessions was the same known project. */
  repeatSameProject: boolean;
  /** ...and at least one of those earlier sessions was a DIFFERENT known project. */
  repeatOtherProject: boolean;
}

export function detectCorrections(session: SessionTurns): CorrectionEvent[] {
  const out: CorrectionEvent[] = [];
  const seenHere = new Set<string>();
  session.turns.forEach((turn, i) => {
    if (turn.role !== 'user') return;
    const prev = session.turns[i - 1];
    if (!isCorrection(turn.text, prev?.role === 'agent')) return;
    const signature = correctionSignature(turn.text);
    const matchable = isMatchableSignature(signature);
    out.push({
      source: session.source, sessionId: session.sessionId, project: session.project,
      startedAt: session.startedAt, turnIndex: i, text: turn.text, signature, matchable,
      context: session.turns.slice(Math.max(0, i - 2), i),
      withinSessionRepeat: matchable && seenHere.has(signature),
      repeat: false, repeatSameProject: false, repeatOtherProject: false,
    });
    if (matchable) seenHere.add(signature);
  });
  return out;
}

export interface Breakdown {
  sessions: number;
  userTurns: number;
  corrections: number;
  matchableCorrections: number;
  repeatEvents: number;
  repeatedCorrectionRate: number;
}

export interface SignatureSummary {
  signature: string;
  sessions: number;
  events: number;
  projects: string[];
  sources: Source[];
  example: string;
}

export interface CensusReport {
  generatedAt: string;
  definitions: Record<string, string>;
  sessionsScanned: number;
  userTurns: number;
  correctionsDetected: number;
  contentFreeCorrections: number;
  matchableCorrections: number;
  distinctSignatures: number;
  repeatedSignatures: number;
  crossProjectSignatures: number;
  crossSourceSignatures: number;
  repeatedEvents: number;
  repeatedEventsSameProject: number;
  repeatedEventsCrossProject: number;
  withinSessionRepeatEvents: number;
  repeatedCorrectionRate: number;
  repeatedCorrectionRateMatchableOnly: number;
  crossProjectRepeatRate: number;
  bySource: Record<string, Breakdown>;
  byProject: Record<string, Breakdown>;
  topRepeatedSignatures: SignatureSummary[];
  topCrossProjectSignatures: SignatureSummary[];
}

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 10000) / 10000 : 0);

/** Order sessions deterministically: start time, then source, then id. */
function sessionOrder(a: SessionTurns, b: SessionTurns): number {
  return a.startedAt - b.startedAt || a.source.localeCompare(b.source) || a.sessionId.localeCompare(b.sessionId);
}

export function runCensus(sessionsIn: SessionTurns[], now = new Date()): { report: CensusReport; events: CorrectionEvent[] } {
  const sessions = [...sessionsIn].sort(sessionOrder);
  const events: CorrectionEvent[] = [];
  // signature -> earlier sessions (key -> project) in which it already appeared
  const history = new Map<string, Map<string, string>>();
  const sigStats = new Map<string, { sessions: Set<string>; events: number; projects: Set<string>; sources: Set<Source>; example: string }>();

  // Sessions sharing the same start time are not "earlier" than each other.
  let i = 0;
  while (i < sessions.length) {
    let j = i;
    while (j < sessions.length && sessions[j].startedAt === sessions[i].startedAt) j++;
    const batch = sessions.slice(i, j).map(s => ({ s, evs: detectCorrections(s) }));
    for (const { s, evs } of batch) {
      const key = `${s.source}:${s.sessionId}`;
      for (const ev of evs) {
        if (ev.matchable) {
          const earlier = history.get(ev.signature);
          if (earlier) {
            for (const [otherKey, project] of earlier) {
              if (otherKey === key) continue;
              ev.repeat = true;
              if (project !== UNKNOWN_PROJECT && s.project !== UNKNOWN_PROJECT) {
                if (project === s.project) ev.repeatSameProject = true;
                else ev.repeatOtherProject = true;
              }
            }
          }
          const st = sigStats.get(ev.signature) ?? { sessions: new Set(), events: 0, projects: new Set(), sources: new Set(), example: ev.text };
          st.sessions.add(key); st.events++; st.projects.add(s.project); st.sources.add(s.source);
          sigStats.set(ev.signature, st);
        }
        events.push(ev);
      }
    }
    for (const { s, evs } of batch) {
      const key = `${s.source}:${s.sessionId}`;
      for (const ev of evs) {
        if (!ev.matchable) continue;
        const h = history.get(ev.signature) ?? new Map<string, string>();
        h.set(key, s.project);
        history.set(ev.signature, h);
      }
    }
    i = j;
  }

  const breakdown = (pick: (s: SessionTurns) => string, pickEv: (e: CorrectionEvent) => string) => {
    const out: Record<string, Breakdown> = {};
    const get = (k: string) => (out[k] ??= { sessions: 0, userTurns: 0, corrections: 0, matchableCorrections: 0, repeatEvents: 0, repeatedCorrectionRate: 0 });
    for (const s of sessions) { const b = get(pick(s)); b.sessions++; b.userTurns += s.turns.filter(t => t.role === 'user').length; }
    for (const e of events) { const b = get(pickEv(e)); b.corrections++; if (e.matchable) b.matchableCorrections++; if (e.repeat) b.repeatEvents++; }
    for (const b of Object.values(out)) b.repeatedCorrectionRate = ratio(b.repeatEvents, b.corrections);
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };

  const summarize = (sig: string): SignatureSummary => {
    const st = sigStats.get(sig)!;
    return { signature: sig, sessions: st.sessions.size, events: st.events, projects: [...st.projects].sort(), sources: [...st.sources].sort() as Source[], example: st.example.slice(0, 200) };
  };
  const knownProjects = (sig: string) => [...sigStats.get(sig)!.projects].filter(p => p !== UNKNOWN_PROJECT).length;
  const repeatedSigs = [...sigStats.keys()].filter(sig => sigStats.get(sig)!.sessions.size >= 2);
  const crossProjectSigs = repeatedSigs.filter(sig => knownProjects(sig) >= 2);
  const bySessionsDesc = (a: string, b: string) => sigStats.get(b)!.sessions.size - sigStats.get(a)!.sessions.size || a.localeCompare(b);

  const matchable = events.filter(e => e.matchable).length;
  const repeated = events.filter(e => e.repeat).length;
  const crossProject = events.filter(e => e.repeatOtherProject).length;

  const report: CensusReport = {
    generatedAt: now.toISOString(),
    definitions: {
      correction: `user message <= ${MAX_CORRECTION_CHARS} chars / ${MAX_CORRECTION_WORDS} words, matching a pushback pattern, directly after an agent turn`,
      signature: 'lowercased, punctuation/emoji stripped, leading no/dont/please/just/actually/stop and trailing please/thanks dropped (lossy, see src/correction-census.ts)',
      contentFree: `signature under ${MIN_SIGNATURE_WORDS} words ("no", "stop", "revert"): counted as a correction, never as a repeat`,
      repeatEvent: 'a correction whose signature already appeared in a strictly earlier session (headline numerator)',
      repeatedCorrectionRate: 'repeatedEvents / correctionsDetected',
      crossProject: 'repeat where an earlier session with the same signature was a different known project (unknown projects never count)',
    },
    sessionsScanned: sessions.length,
    userTurns: sessions.reduce((n, s) => n + s.turns.filter(t => t.role === 'user').length, 0),
    correctionsDetected: events.length,
    contentFreeCorrections: events.length - matchable,
    matchableCorrections: matchable,
    distinctSignatures: sigStats.size,
    repeatedSignatures: repeatedSigs.length,
    crossProjectSignatures: crossProjectSigs.length,
    crossSourceSignatures: repeatedSigs.filter(sig => sigStats.get(sig)!.sources.size >= 2).length,
    repeatedEvents: repeated,
    repeatedEventsSameProject: events.filter(e => e.repeatSameProject).length,
    repeatedEventsCrossProject: crossProject,
    withinSessionRepeatEvents: events.filter(e => e.withinSessionRepeat).length,
    repeatedCorrectionRate: ratio(repeated, events.length),
    repeatedCorrectionRateMatchableOnly: ratio(repeated, matchable),
    crossProjectRepeatRate: ratio(crossProject, events.length),
    bySource: breakdown(s => s.source, e => e.source),
    byProject: breakdown(s => s.project, e => e.project),
    topRepeatedSignatures: repeatedSigs.sort(bySessionsDesc).slice(0, 25).map(summarize),
    topCrossProjectSignatures: crossProjectSigs.sort(bySessionsDesc).slice(0, 25).map(summarize),
  };
  return { report, events };
}

// -------------------------------------------------------------------- sample

/** Deterministic, evenly spaced sample across all events (ordered by session time). */
export function sampleEvents(events: CorrectionEvent[], n = 50): CorrectionEvent[] {
  if (events.length <= n) return [...events];
  const step = events.length / n;
  return Array.from({ length: n }, (_, k) => events[Math.floor(k * step)]);
}

const oneLine = (s: string, max = 220) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
};

export function renderSample(sample: CorrectionEvent[], totalEvents: number): string {
  const lines = [
    '# Correction census: hand-label sample',
    '',
    `${sample.length} of ${totalEvents} detected corrections, evenly spaced by session time.`,
    'Mark each one: is it really a correction of the agent\'s previous turn? Precision = yes / labelled.',
    '',
  ];
  sample.forEach((e, k) => {
    lines.push(`## ${k + 1}. ${e.source} · ${e.project} · session \`${e.sessionId}\` · turn ${e.turnIndex}`);
    lines.push('');
    if (!e.context.length) lines.push('> (no preceding context)');
    for (const t of e.context) lines.push(`> **${t.role}:** ${oneLine(t.text)}`);
    lines.push(`> **USER (detected):** ${oneLine(e.text, 400)}`);
    lines.push('');
    const flags = [e.matchable ? `signature \`${e.signature}\`` : 'content-free', e.repeat ? 'REPEAT' : null, e.repeatOtherProject ? 'cross-project' : null, e.withinSessionRepeat ? 'within-session' : null].filter(Boolean).join(' · ');
    lines.push(`${flags}`);
    lines.push('');
    lines.push('- [ ] real correction   - [ ] not a correction');
    lines.push('');
  });
  return lines.join('\n');
}
