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

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode HTML entities some clients leave in pasted text (e.g. "&#x20;" for a space). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * The Codex IDE extension wraps each prompt in "# Context from my IDE setup:
 * ... ## My request for Codex: <prompt>". Only the part after the marker is
 * the user's voice. A wrapper with no marker is all context: returns ''.
 */
const IDE_CONTEXT = /^#\s*(Context from my IDE setup|Files mentioned by the user|Files pasted by the user)\s*:/i;
const IDE_REQUEST = /##\s*My request for Codex:\s*/i;

/**
 * Harness blocks inside a user message (Claude Code): opened-file and
 * selection context, background task notifications, pasted content, notes,
 * reminders. Removed wherever they appear; any text left over is the user's.
 */
const HARNESS_BLOCK = /<(ide_opened_file|ide_selection|task-notification|pasted_content|note|system-reminder)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Codex's notice after the user interrupts a turn, sent as a user message:
 * "The user interrupted the previous turn on purpose. ... verify current
 * state before retrying." Anything after the notice is kept.
 */
const INTERRUPT_NOTICE = /^The user interrupted the previous turn on purpose[\s\S]*?(before retrying\.?|$)/i;

/** Whole messages that are not the user's voice. */
const CLIENT_INJECTED = [
  /^\[System:/,                                                   // Hermes retry after a dropped stream
  /^(The attached )?pasted text( file\(s\))? contains? the user'?s request/i, // Codex: the real request is in an attachment
  /graph community summaries with community IDs/i,                // graphify's scripted naming prompt run through Codex
];

/** Normalize one user message from any source; '' means "not the user's voice". */
export function cleanUserText(raw: string): string {
  let t = raw.trim();
  if (IDE_CONTEXT.test(t)) {
    const m = IDE_REQUEST.exec(t);
    t = m ? t.slice(m.index + m[0].length) : '';
  }
  t = t.replace(HARNESS_BLOCK, ' ').replace(INTERRUPT_NOTICE, ' ');
  t = decodeEntities(t).trim();
  if (CLIENT_INJECTED.some(re => re.test(t))) return '';
  return t;
}

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
      const text = isSystemInjected(ev.text.trim()) ? '' : cleanUserText(ev.text);
      if (text) turns.push({ role: 'user', text });
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
        const text = isClaudeCodeInjected(c.text) ? '' : cleanUserText(c.text);
        if (text) turns.push({ role: 'user', text });
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
    if (row.role === 'user') {
      // Client-injected rows (e.g. "[System: ... cut off ...]") clean to '' and are skipped entirely.
      const clean = cleanUserText(text);
      if (clean) turns.push({ role: 'user', text: clean });
    }
    else if (row.role !== 'system') turns.push({ role: 'agent', text: text || `[${row.role}]` });
  }
  return { source: 'hermes', sessionId, project, startedAt: toMs(startedAt), turns };
}

// ----------------------------------------------------------------- detection

/** "Short-ish": longer messages are usually new task specs, not pushback. */
export const MAX_CORRECTION_CHARS = 280;
export const MAX_CORRECTION_WORDS = 45;

/**
 * Detector v2. v1's false positives in a 50-item hand-read of real logs fell
 * into four classes, each narrowed here (these rules were derived from that
 * sample, so precision re-measured on the same items is optimistic):
 *  1. open "why" questions ("why did it break?", "why is that important?")
 *     -> only "why did/do/are/would/didn't/can't... you" counts;
 *  2. first-person "I don't know / I don't have" -> "i don't" never triggers;
 *  3. agreement opened with no/nope/nah ("no it's fine", "nope that makes sense");
 *  4. praise opened with "that's" ("that's great progress").
 */
export const DETECTOR_VERSION = 2;

/** Must START the message (after optional "ok,"/"hmm,"-style lead-ins are NOT stripped: kept coarse). */
const STARTS = /^(no\b|nope\b|nah\b|stop\b|wrong\b|that'?s\b|thats\b|actually\b|use\b|instead\b|revert\b|undo\b|remove\b|change\b|not\b|fix\b|don'?t\b|do not\b|why\s+(did|do|are|would|didn'?t|didnt|can'?t|cant|won'?t|wont|have|haven'?t|aren'?t|keep)\s+you\b)/;
/** May appear ANYWHERE. Narrower than STARTS: "use"/"fix"/"change"/"not"/"why" mid-sentence are too common. */
const CONTAINS = /\b(don'?t|do not|stop|wrong|instead|revert|undo|not what i|i said|i told you|again\?)\b/;
/** First person "I don't ..." describes the user, not the agent ("I don't have any keys"). */
const FIRST_PERSON_NEGATION = /\bi\s+(don'?t|do not|dont)\b/g;
/** "no it's fine", "nah its ok", "nope that makes more sense", "no worries". */
const AGREEMENT = /^(no|nope|nah)\b[\s,.!]*(it'?s|its|that'?s|thats|that|all)?\s*(fine|ok|okay|good|alright|makes|worries|problem)\b/;
/** "that's great", "thats perfect", "that's it". */
const PRAISE = /^(that'?s|thats)\s+(great|good|perfect|fine|awesome|nice|cool|amazing|exactly|correct|right|it|brilliant|smart)\b/;

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
  if (AGREEMENT.test(t) || PRAISE.test(t)) return false;
  return STARTS.test(t) || CONTAINS.test(t.replace(FIRST_PERSON_NEGATION, ' '));
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
  /** Fuzzy (content-word) cluster id; set by runCensus. */
  fuzzyCluster: number;
  fuzzyRepeat: boolean;
  fuzzyRepeatSameProject: boolean;
  fuzzyRepeatOtherProject: boolean;
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
      fuzzyCluster: -1, fuzzyRepeat: false, fuzzyRepeatSameProject: false, fuzzyRepeatOtherProject: false,
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
  /** User turns directly after an agent turn: the detector's eligible pool (0 here suggests a reader bug). */
  userTurnsAfterAgent: number;
  fuzzyRepeatEvents: number;
  fuzzyRepeatedCorrectionRate: number;
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
  /** Same counts with fuzzy (content-word) matching instead of exact signatures. */
  fuzzy: {
    method: string;
    clusters: number;
    repeatedClusters: number;
    crossProjectClusters: number;
    crossSourceClusters: number;
    repeatedEvents: number;
    repeatedEventsSameProject: number;
    repeatedEventsCrossProject: number;
    repeatedCorrectionRate: number;
    crossProjectRepeatRate: number;
    topRepeatedClusters: ClusterSummary[];
    topCrossProjectClusters: ClusterSummary[];
  };
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

  // Fuzzy pass: same correction in different words (content-word overlap).
  const fz = fuzzyRecurrence(events.map(e => ({ sessionKey: `${e.source}:${e.sessionId}`, project: e.project, startedAt: e.startedAt, words: contentWords(e.text) })));
  events.forEach((e, k) => {
    e.fuzzyCluster = fz.clusterOf[k]; e.fuzzyRepeat = fz.repeat[k];
    e.fuzzyRepeatSameProject = fz.repeatSameProject[k]; e.fuzzyRepeatOtherProject = fz.repeatOtherProject[k];
  });
  const fuzzyClusters = summarizeClusters(events.map(e => ({ sessionKey: `${e.source}:${e.sessionId}`, source: e.source, project: e.project, text: e.text })), fz.clusterOf);

  const breakdown = (pick: (s: SessionTurns) => string, pickEv: (e: CorrectionEvent) => string) => {
    const out: Record<string, Breakdown> = {};
    const get = (k: string) => (out[k] ??= { sessions: 0, userTurns: 0, corrections: 0, matchableCorrections: 0, repeatEvents: 0, repeatedCorrectionRate: 0, userTurnsAfterAgent: 0, fuzzyRepeatEvents: 0, fuzzyRepeatedCorrectionRate: 0 });
    for (const s of sessions) {
      const b = get(pick(s)); b.sessions++;
      s.turns.forEach((t, i) => { if (t.role !== 'user') return; b.userTurns++; if (s.turns[i - 1]?.role === 'agent') b.userTurnsAfterAgent++; });
    }
    for (const e of events) { const b = get(pickEv(e)); b.corrections++; if (e.matchable) b.matchableCorrections++; if (e.repeat) b.repeatEvents++; if (e.fuzzyRepeat) b.fuzzyRepeatEvents++; }
    for (const b of Object.values(out)) { b.repeatedCorrectionRate = ratio(b.repeatEvents, b.corrections); b.fuzzyRepeatedCorrectionRate = ratio(b.fuzzyRepeatEvents, b.corrections); }
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
      correction: `detector v${DETECTOR_VERSION}: user message <= ${MAX_CORRECTION_CHARS} chars / ${MAX_CORRECTION_WORDS} words, matching a pushback pattern, directly after an agent turn; excludes open why-questions, first-person "I don't", and no/that's-led agreement or praise`,
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
    fuzzy: {
      method: FUZZY_METHOD,
      clusters: fuzzyClusters.length,
      repeatedClusters: fuzzyClusters.filter(c => c.sessions >= 2).length,
      crossProjectClusters: fuzzyClusters.filter(c => c.sessions >= 2 && c.knownProjects >= 2).length,
      crossSourceClusters: fuzzyClusters.filter(c => c.sessions >= 2 && c.sources.length >= 2).length,
      repeatedEvents: events.filter(e => e.fuzzyRepeat).length,
      repeatedEventsSameProject: events.filter(e => e.fuzzyRepeatSameProject).length,
      repeatedEventsCrossProject: events.filter(e => e.fuzzyRepeatOtherProject).length,
      repeatedCorrectionRate: ratio(events.filter(e => e.fuzzyRepeat).length, events.length),
      crossProjectRepeatRate: ratio(events.filter(e => e.fuzzyRepeatOtherProject).length, events.length),
      topRepeatedClusters: fuzzyClusters.filter(c => c.sessions >= 2).slice(0, 25),
      topCrossProjectClusters: fuzzyClusters.filter(c => c.sessions >= 2 && c.knownProjects >= 2).slice(0, 25),
    },
  };
  return { report, events };
}

// --------------------------------------------------------------- fuzzy match

/**
 * Words that carry no meaning about WHAT the user wants. Includes "dont"/"not"/
 * "no", so (like the exact signature) negation is lost: "add comments" and
 * "don't add comments" share a cluster. Check the sample for such collisions.
 */
const STOPWORDS = new Set((
  'a an the and or but if then so to of in on at for with from by as is are was were be been being am ' +
  'it its this that these those there here i you we they he she me my your our us them their ' +
  'do does did done doing dont doesnt didnt not no nope yes yeah ok okay hey please pls just actually also ' +
  'can could would should will shall may might must have has had having get got gets ' +
  'what why how when where which who whom whose all any some more very really now again still too than ' +
  'about into over like want need know think let lets thing things one ones something anything way ' +
  'im ive youre youve thats theres its isnt arent wasnt cant wont'
).split(' '));

/** Crude suffix stripping so adding/added/adds -> add, comments -> comment. Not a real stemmer. */
export function stem(word: string): string {
  let w = word;
  let stripped = false;
  if (w.length > 5 && w.endsWith('ing')) { w = w.slice(0, -3); stripped = true; }
  else if (w.length > 4 && w.endsWith('ed')) { w = w.slice(0, -2); stripped = true; }
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  // stopping -> stopp -> stop; but add(ing) -> add stays
  if (stripped && w.length > 3 && w[w.length - 1] === w[w.length - 2] && !/[sl]/.test(w[w.length - 1])) w = w.slice(0, -1);
  return w;
}

/** Sorted, unique, stemmed content words. */
export function contentWords(text: string): string[] {
  const words = text.toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOPWORDS.has(w))
    .map(stem);
  return [...new Set(words)].sort();
}

export const FUZZY_JACCARD = 0.5;
export const FUZZY_METHOD = `content-word sets (stopwords dropped, crude stemming); two items match when Jaccard >= ${FUZZY_JACCARD} and they share >= min(2, smaller set size) words; clusters are single-link (A~B, B~C puts A and C together)`;

/** Do two content-word sets say "the same thing"? */
export function similarWords(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const setB = new Set(b);
  const shared = a.filter(w => setB.has(w)).length;
  const union = a.length + b.length - shared;
  return shared >= Math.min(2, a.length, b.length) && shared / union >= FUZZY_JACCARD;
}

/** Single-link clustering via union-find; candidate pairs come from an inverted word index. */
export function clusterWordSets(sets: string[][]): number[] {
  const parent = sets.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const index = new Map<string, number[]>();
  sets.forEach((ws, i) => { for (const w of ws) { const l = index.get(w) ?? []; l.push(i); index.set(w, l); } });
  sets.forEach((ws, i) => {
    const candidates = new Set<number>();
    for (const w of ws) for (const j of index.get(w)!) if (j > i) candidates.add(j);
    for (const j of candidates) {
      if (find(i) !== find(j) && similarWords(ws, sets[j])) parent[find(j)] = find(i);
    }
  });
  // Renumber roots to dense ids in first-appearance order (deterministic).
  const ids = new Map<number, number>();
  return sets.map((_, i) => { const r = find(i); if (!ids.has(r)) ids.set(r, ids.size); return ids.get(r)!; });
}

export interface Occurrence {
  sessionKey: string;
  project: string;
  startedAt: number;
  words: string[];
}

export interface FuzzyResult {
  clusterOf: number[];
  repeat: boolean[];
  repeatSameProject: boolean[];
  repeatOtherProject: boolean[];
}

/** For each item: is any member of its cluster in a strictly earlier, different session? */
export function fuzzyRecurrence(items: Occurrence[]): FuzzyResult {
  const clusterOf = clusterWordSets(items.map(i => i.words));
  const members = new Map<number, number[]>();
  clusterOf.forEach((c, k) => { const l = members.get(c) ?? []; l.push(k); members.set(c, l); });
  const repeat = items.map(() => false), same = items.map(() => false), other = items.map(() => false);
  items.forEach((it, k) => {
    for (const j of members.get(clusterOf[k])!) {
      const o = items[j];
      if (o.sessionKey === it.sessionKey || !(o.startedAt < it.startedAt)) continue;
      repeat[k] = true;
      if (o.project !== UNKNOWN_PROJECT && it.project !== UNKNOWN_PROJECT) {
        if (o.project === it.project) same[k] = true; else other[k] = true;
      }
    }
  });
  return { clusterOf, repeat, repeatSameProject: same, repeatOtherProject: other };
}

export interface ClusterSummary {
  cluster: number;
  members: number;
  sessions: number;
  knownProjects: number;
  projects: string[];
  sources: Source[];
  examples: string[];
}

/** Clusters ordered by distinct sessions, then members, then id. */
export function summarizeClusters(items: Array<{ sessionKey: string; source: Source; project: string; text: string }>, clusterOf: number[]): ClusterSummary[] {
  const by = new Map<number, number[]>();
  clusterOf.forEach((c, k) => { const l = by.get(c) ?? []; l.push(k); by.set(c, l); });
  const out: ClusterSummary[] = [];
  for (const [cluster, ks] of by) {
    const projects = [...new Set(ks.map(k => items[k].project))].sort();
    const examples: string[] = [];
    for (const k of ks) { const t = items[k].text.replace(/\s+/g, ' ').trim().slice(0, 200); if (!examples.includes(t) && examples.length < 4) examples.push(t); }
    out.push({
      cluster, members: ks.length,
      sessions: new Set(ks.map(k => items[k].sessionKey)).size,
      knownProjects: projects.filter(p => p !== UNKNOWN_PROJECT).length,
      projects, sources: [...new Set(ks.map(k => items[k].source))].sort() as Source[], examples,
    });
  }
  return out.sort((a, b) => b.sessions - a.sessions || b.members - a.members || a.cluster - b.cluster);
}

// ------------------------------------------------------- eval workspace filter

/**
 * Project names created by this repo's own experiments (Runs 01-10 and the
 * harness smoke test): paired arms, condition copies, smoke dirs. Their
 * sessions are scripted prompts, not the user's voice. `memory` and
 * `baseline` match the run condition names (7 one-turn sessions each in the
 * first census); author/b1/b2/final are the password-reset verifier trial.
 * If you have a real project with one of these names, use --include-eval.
 */
const EVAL_PROJECT = /^(arm-[a-z]-\d+|run-\d+-[a-z0-9-]+|amg-smoke-[a-z0-9]+|builder-[a-z]|baseline|memory|static-note|automatic-memory|author|b\d+|final)$/;

export function isEvalProject(project: string): boolean {
  return project.startsWith('projects/') && EVAL_PROJECT.test(project.slice('projects/'.length));
}

// -------------------------------------------------------- standing instructions

/** User turns longer than this are mostly pasted logs/specs; clauses from them are noise. */
export const MAX_INSTRUCTION_TURN_CHARS = 1500;
const MIN_CLAUSE_WORDS = 3, MAX_CLAUSE_WORDS = 25, MIN_CLAUSE_CONTENT = 2;
/** Marks a clause that reads like a rule about HOW to work, not WHAT to build. */
const DIRECTIVE = /\b(always|never|dont|do not|keep going|keep|make sure|ask|stop|continue|until|before|without|only|prefer|instead|avoid|remember|don t)\b/;

/**
 * Split a user turn into clauses: sentence punctuation, commas, semicolons,
 * newlines, and " and "/" but "/" then ". "fix the pipeline and if you dont
 * know please ask what is unclear" yields "if you dont know please ask what
 * is unclear" as its own clause.
 */
export function splitClauses(text: string): string[] {
  return text
    .replace(/[‘’]/g, "'")
    // Sentence punctuation splits only when followed by whitespace/end, so test.ts and v1.2 stay whole.
    .split(/[.!?,]+(?=\s|$)|[;\n\r]+|\s+(?:and|but|then|also)\s+/i)
    .map(c => c.replace(/\s+/g, ' ').trim())
    .filter(c => { const n = c.split(' ').length; return n >= MIN_CLAUSE_WORDS && n <= MAX_CLAUSE_WORDS; });
}

export function isDirective(clause: string): boolean {
  return DIRECTIVE.test(clause.toLowerCase().replace(/[‘’']/g, ''));
}

export interface InstructionCluster extends ClusterSummary {
  directive: boolean;
}

export interface StandingInstructionReport {
  method: string;
  userTurnsScanned: number;
  userTurnsSkippedAsPasted: number;
  clauses: number;
  clusters: number;
  recurringClusters: number;
  crossProjectClusters: number;
  crossSourceClusters: number;
  directiveRecurringClusters: number;
  topCrossProject: InstructionCluster[];
  topDirective: InstructionCluster[];
  topRecurring: InstructionCluster[];
}

export interface ClauseItem {
  sessionKey: string;
  source: Source;
  sessionId: string;
  project: string;
  startedAt: number;
  turnIndex: number;
  text: string;
  words: string[];
}

/** Every clause of every user turn short enough to be typed (not pasted), with its position. */
export function instructionClauses(sessions: SessionTurns[]): { items: ClauseItem[]; scanned: number; pasted: number } {
  const items: ClauseItem[] = [];
  let scanned = 0, pasted = 0;
  for (const s of sessions) {
    s.turns.forEach((t, turnIndex) => {
      if (t.role !== 'user') return;
      scanned++;
      if (t.text.length > MAX_INSTRUCTION_TURN_CHARS) { pasted++; return; }
      for (const clause of splitClauses(t.text)) {
        const words = contentWords(clause);
        if (words.length >= MIN_CLAUSE_CONTENT) items.push({ sessionKey: `${s.source}:${s.sessionId}`, source: s.source, sessionId: s.sessionId, project: s.project, startedAt: s.startedAt, turnIndex, text: clause, words });
      }
    });
  }
  return { items, scanned, pasted };
}

/** Recurring clauses across ALL user turns (not just pushback). Counted once per session per cluster. */
export function standingInstructions(sessions: SessionTurns[]): StandingInstructionReport {
  const { items, scanned, pasted } = instructionClauses(sessions);
  const clusterOf = clusterWordSets(items.map(i => i.words));
  const directiveOf = new Map<number, boolean>();
  items.forEach((it, k) => { if (isDirective(it.text)) directiveOf.set(clusterOf[k], true); });
  const all: InstructionCluster[] = summarizeClusters(items, clusterOf).map(c => ({ ...c, directive: directiveOf.get(c.cluster) === true }));
  const recurring = all.filter(c => c.sessions >= 2);
  const cross = recurring.filter(c => c.knownProjects >= 2);
  return {
    method: `clauses of ${MIN_CLAUSE_WORDS}-${MAX_CLAUSE_WORDS} words with >= ${MIN_CLAUSE_CONTENT} content words, from user turns <= ${MAX_INSTRUCTION_TURN_CHARS} chars; ${FUZZY_METHOD}; recurring = cluster seen in >= 2 sessions; directive = any member matches an always/never/dont/ask/keep/until/... cue`,
    userTurnsScanned: scanned,
    userTurnsSkippedAsPasted: pasted,
    clauses: items.length,
    clusters: all.length,
    recurringClusters: recurring.length,
    crossProjectClusters: cross.length,
    crossSourceClusters: recurring.filter(c => c.sources.length >= 2).length,
    directiveRecurringClusters: recurring.filter(c => c.directive).length,
    topCrossProject: cross.slice(0, 25),
    topDirective: recurring.filter(c => c.directive).slice(0, 25),
    topRecurring: recurring.slice(0, 25),
  };
}

export function renderStandingInstructions(r: StandingInstructionReport): string {
  const lines = [
    '# Standing instructions: recurring clauses across sessions',
    '',
    `${r.recurringClusters} clusters recur in 2+ sessions (${r.crossProjectClusters} across projects, ${r.crossSourceClusters} across agents, ${r.directiveRecurringClusters} directive-shaped).`,
    'Question to answer while reading: which of these are rules about how YOU like agents to work (personalization), and which are just the same task asked twice?',
    '',
  ];
  const section = (title: string, cs: InstructionCluster[]) => {
    lines.push(`## ${title}`, '');
    if (!cs.length) lines.push('(none)', '');
    for (const c of cs) {
      lines.push(`- **cluster ${c.cluster}** · ${c.sessions} sessions · ${c.projects.join(', ')} · ${c.sources.join(', ')}${c.directive ? ' · directive' : ''}`);
      for (const e of c.examples) lines.push(`  - "${e}"`);
    }
    lines.push('');
  };
  section('Across projects (the personalization signal)', r.topCrossProject);
  section('Directive-shaped (rules about how to work)', r.topDirective);
  section('Most recurring overall', r.topRecurring);
  return lines.join('\n');
}

// ---------------------------------------------------------------- recall check

export interface RecallItem {
  source: Source;
  sessionId: string;
  project: string;
  turnIndex: number;
  text: string;
  previous: Turn;
}

/**
 * User turns right after an agent turn that the detector did NOT flag,
 * evenly spaced, up to perSource from each source. Reading them estimates
 * how many real corrections the coarse patterns miss (recall), and shows
 * whether a source with 0 corrections is quiet or mis-read.
 */
export function recallSample(sessions: SessionTurns[], perSource = 10): RecallItem[] {
  const bySource = new Map<Source, RecallItem[]>();
  for (const s of [...sessions].sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId))) {
    s.turns.forEach((t, i) => {
      const prev = s.turns[i - 1];
      if (t.role !== 'user' || prev?.role !== 'agent' || isCorrection(t.text, true)) return;
      const l = bySource.get(s.source) ?? [];
      l.push({ source: s.source, sessionId: s.sessionId, project: s.project, turnIndex: i, text: t.text, previous: prev });
      bySource.set(s.source, l);
    });
  }
  const out: RecallItem[] = [];
  for (const src of [...bySource.keys()].sort()) {
    const l = bySource.get(src)!;
    const n = Math.min(perSource, l.length), step = l.length / n;
    for (let k = 0; k < n; k++) out.push(l[Math.floor(k * step)]);
  }
  return out;
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

export function renderSample(sample: CorrectionEvent[], totalEvents: number, recall: RecallItem[] = []): string {
  const lines = [
    '# Correction census: hand-label sample',
    '',
    `${sample.length} of ${totalEvents} detected corrections.`,
    'Grouped by fuzzy cluster (same content words), so corrections that may say the same thing sit together.',
    'For each one mark: is it really a correction? For grouped ones also mark: does it mean the same as the rest of its group?',
    '',
  ];
  const entry = (e: CorrectionEvent, grouped: boolean) => {
    lines.push(`### ${e.source} · ${e.project} · session \`${e.sessionId}\` · turn ${e.turnIndex}`);
    lines.push('');
    if (!e.context.length) lines.push('> (no preceding context)');
    for (const t of e.context) lines.push(`> **${t.role}:** ${oneLine(t.text)}`);
    lines.push(`> **USER (detected):** ${oneLine(e.text, 400)}`);
    lines.push('');
    const flags = [e.matchable ? `signature \`${e.signature}\`` : 'content-free', e.repeat ? 'EXACT REPEAT' : null, e.fuzzyRepeat ? 'FUZZY REPEAT' : null, e.fuzzyRepeatOtherProject ? 'cross-project' : null, e.withinSessionRepeat ? 'within-session' : null].filter(Boolean).join(' · ');
    lines.push(flags, '');
    lines.push(grouped ? '- [ ] real correction   - [ ] not a correction   - [ ] same meaning as its group' : '- [ ] real correction   - [ ] not a correction');
    lines.push('');
  };
  const groups = new Map<number, CorrectionEvent[]>();
  for (const e of sample) { const g = groups.get(e.fuzzyCluster) ?? []; g.push(e); groups.set(e.fuzzyCluster, g); }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
  const multi = ordered.filter(([, g]) => g.length >= 2), single = ordered.filter(([, g]) => g.length < 2);
  lines.push(`## Groups that may be the same correction (${multi.length})`, '');
  if (!multi.length) lines.push('(none)', '');
  for (const [id, g] of multi) {
    lines.push(`## Group ${id}: ${g.length} corrections in ${new Set(g.map(e => `${e.source}:${e.sessionId}`)).size} sessions`, '');
    for (const e of g) entry(e, true);
  }
  lines.push(`## One-off corrections (${single.length})`, '');
  for (const [, g] of single) entry(g[0], false);
  if (recall.length) {
    lines.push('## Recall check: turns the detector did NOT flag', '');
    lines.push('User turns right after an agent turn, evenly spaced per source. Mark any that are really corrections: those are misses.', '');
    for (const r of recall) {
      lines.push(`### ${r.source} · ${r.project} · session \`${r.sessionId}\` · turn ${r.turnIndex}`, '');
      lines.push(`> **agent:** ${oneLine(r.previous.text)}`);
      lines.push(`> **USER (not flagged):** ${oneLine(r.text, 400)}`, '');
      lines.push('- [ ] missed correction', '');
    }
  }
  return lines.join('\n');
}
