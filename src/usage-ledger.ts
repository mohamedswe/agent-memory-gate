/**
 * Session usage ledger — the in-session short-term store.
 * Counts how often information is used within one session so rehearsed or
 * repeatedly re-derived knowledge can be gated into long-term memory.
 * In-memory only, deterministic, no inference, no persistence.
 */
import { commandActionKeys, type CommandContext } from './command-identity';
import { isSystemInjected } from './injection-filter';

export interface UsageCounts {
  userRepeats: number;
  agentRediscoveries: number;
  rawMentions: number;
}

export interface PromotionCandidate {
  key: string;
  counts: UsageCounts;
  firstSeenText: string;
  sourceKeys?: string[];
}

/** Deterministic normalization: case-fold, collapse whitespace, strip punctuation. */
function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"()[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Unknown arguments retain exact content; shell normalization is separate. */
function normalizeArg(value: string): string {
  return value;
}

/** Stable, sorted-key JSON for nested args — never "[object Object]". */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableSerialize((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** Keys that must reach userRepeats/agentRediscoveries >= 2 to become candidates. */
const PROMOTION_THRESHOLD = 2;

/**
 * Minimum normalized content for promotion. Real-session probing showed bare
 * conversational flow ("continue", "ok", empty) crossing the repeat threshold;
 * repetition of flow is not knowledge. Words with substance count even when short.
 */
const FLOW_TOKENS = new Set(['continue', 'ok', 'okay', 'yes', 'no', 'go', 'next', 'stop', 'again', 'run', 'try', 'done', 'y', 'n']);
const MIN_PROMOTABLE_WORDS = 2;

function promotableKey(key: string): boolean {
  const words = key.split(' ').filter(Boolean);
  if (words.length < MIN_PROMOTABLE_WORDS) {
    // Single word is promotable only if it is not conversational flow.
    return words.length === 1 && !FLOW_TOKENS.has(words[0]);
  }
  return true;
}

/** Stable identity for an effective tool call: tool + sorted, stably-serialized args. */
function toolCallKey(tool: string, args: Record<string, unknown>): string {
  const parts = Object.keys(args)
    .sort()
    .map(name => `${name}=${normalizeArg(typeof args[name] === 'object' && args[name] !== null ? stableSerialize(args[name]) : String(args[name]))}`);
  return `tool:${tool}:${parts.join(':')}`;
}

export class UsageLedger {
  private readonly entries = new Map<string, { counts: UsageCounts; firstSeenText: string; sourceKeys?: Set<string> }>();
  private readonly context: CommandContext;
  constructor(context: CommandContext = {}) {
    this.context={...context,packageScripts:context.packageScripts?{...context.packageScripts}:undefined};
  }

  /** Record a user/caller mention of a piece of information. */
  recordUserMention(text: string): void {
    const key = normalizeKey(text);
    const entry = this.entries.get(key);
    if (entry) {
      entry.counts.userRepeats += 1;
      entry.counts.rawMentions += 1;
    } else {
      this.entries.set(key, {
        counts: { userRepeats: 1, agentRediscoveries: 0, rawMentions: 1 },
        firstSeenText: text,
      });
    }
  }

  /** Record the agent performing a tool call; identical effective calls count as rediscoveries. */
  recordToolCall(tool: string, args: Record<string, unknown>): void {
    const original=toolCallKey(tool,args);
    for(const key of commandActionKeys(tool,args,this.context)??[original]) {
      const entry=this.entries.get(key);
      if(entry){entry.counts.agentRediscoveries++;entry.counts.rawMentions++;entry.sourceKeys??=new Set();entry.sourceKeys.add(original);}
      else this.entries.set(key,{counts:{userRepeats:0,agentRediscoveries:1,rawMentions:1},firstSeenText:original,sourceKeys:new Set([original])});
    }
  }

  sourceKeysFor(key: string): string[] { return [...(this.entries.get(key)?.sourceKeys??[])]; }

  /** Record agent-text/assistant mention observed but NOT a promotion signal. */
  recordRawMention(text: string): void {
    const key = normalizeKey(text);
    const entry = this.entries.get(key);
    if (entry) {
      entry.counts.rawMentions += 1;
    } else {
      this.entries.set(key, {
        counts: { userRepeats: 0, agentRediscoveries: 0, rawMentions: 1 },
        firstSeenText: text,
      });
    }
  }

  /** Observed counts for a key, or null when never seen. */
  countsFor(text: string): UsageCounts | null {
    const entry = this.entries.get(normalizeKey(text));
    return entry ? { ...entry.counts } : null;
  }

  /**
   * All substantive observed keys (any count, including single mentions) —
   * the input for cross-session repetition: a key that appears once in many
   * sessions never crosses the within-session threshold but is the textbook
   * durable procedure. Flow-only keys (ok/continue/...) are excluded — they
   * appear in every session and must not accumulate into candidates.
   */
  rawKeys(): string[] {
    const out: string[] = [];
    for (const [key, entry] of this.entries) {
      if (isSystemInjected(entry.firstSeenText) || isSystemInjected(key)) continue;
      // bare flow tokens ('continue', 'ok', ...) must not accumulate either
      const words = key.split(' ').filter(Boolean);
      if (words.length === 1 && FLOW_TOKENS.has(words[0])) continue;
      if (promotableKey(entry.firstSeenText) || promotableKey(key)) out.push(key);
    }
    return out;
  }

  /** Keys whose repeats/rediscoveries crossed the threshold, with counts as provenance. */
  promotionCandidates(): PromotionCandidate[] {
    const candidates: PromotionCandidate[] = [];
    for (const [key, entry] of this.entries) {
      if(isSystemInjected(entry.firstSeenText)||isSystemInjected(key))continue;
      if (
        (entry.counts.userRepeats >= PROMOTION_THRESHOLD ||
          entry.counts.agentRediscoveries >= PROMOTION_THRESHOLD) &&
        promotableKey(key)
      ) {
        candidates.push({ key, counts: { ...entry.counts }, firstSeenText: entry.firstSeenText,
          ...(entry.sourceKeys?{sourceKeys:[...entry.sourceKeys]}:{}) });
      }
    }
    return candidates;
  }
}
