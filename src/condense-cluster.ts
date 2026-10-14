/**
 * Deterministic clustering for the condense pass: near-duplicate memories
 * group by shared core signals (commands, paths, tool patterns) within a
 * project. No embeddings, no LLM — pure string signals. Singletons pass
 * through as singleton clusters.
 */

export interface CondensableRecord {
  slug: string;
  recordId: string;
  projectId: string;
  content: string;
}

export interface Cluster {
  /** Representative signal shared by the members. */
  signal: string;
  projectId: string;
  members: CondensableRecord[];
}

/**
 * Core signals worth grouping on. Extraction produces a normalized key per
 * match so trivial surface differences (truncation, case, trailing junk)
 * collapse to the same signal.
 */
const SIGNAL_PATTERNS: { name: string; regex: RegExp; normalize?: (match: string) => string }[] = [
  { name: 'npm-script', regex: /npm run ([a-z:_-]+)/gi },
  { name: 'node-test', regex: /node --experimental-strip-types --test (\S+)/gi },
  {
    name: 'docker-compose',
    regex: /docker compose ([^`"']{1,60})/gi,
    normalize: m => m.replace(/\s+/g, ' ').trim(),
  },
  {
    name: 'python',
    regex: /(?:^|[ (])(python(?:\.exe)?|pytest(?:\.exe)?)\b([^`"']{0,40})/gi,
    normalize: m => m.replace(/\s+/g, ' ').trim(),
  },
  {
    // Path containing a doc keyword; key on directory + filename stem so
    // SKILL.md / SKIL / truncations collapse together.
    name: 'skill-path',
    regex: /([A-Za-z]:\\[^'"`\s]*?(?:SKILL|query|reference)[^'"`\s]*)/gi,
    normalize: m => {
      const stem = m.replace(/\.(md|MD)$/, '').replace(/\.\.\.$/, '');
      const parts = stem.split(String.fromCharCode(92));
      const dir = parts.slice(0, -1).join('/');
      // Truncated filenames (SKIL, SKILL, SKILL.m) share a prefix — key on
      // the first 4 chars so surface truncation collapses to one signal.
      const file = (parts.pop() ?? '').toLowerCase().slice(0, 4);
      return `${dir}/${file}`.toLowerCase();
    },
  },
  { name: 'poll-pattern', regex: /write_stdin with empty chars|wait_agent with timeout_ms/gi },
];

function extractSignals(content: string): string[] {
  const signals: string[] = [];
  for (const { name, regex, normalize } of SIGNAL_PATTERNS) {
    const re = new RegExp(regex.source, regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const raw = m[0];
      const key = (normalize ? normalize(raw) : raw).replace(/\s+/g, ' ').trim();
      signals.push(`${name}:${key.toLowerCase()}`);
    }
  }
  return signals;
}

export function clusterRecords(records: CondensableRecord[]): Cluster[] {
  // First-match-wins: signals are ordered most specific first, so a record
  // joins the cluster of its FIRST signal and later signals of the same
  // record don't scatter it further.
  const bySignal = new Map<string, Cluster>(); // projectId::signal -> cluster
  const clusters: Cluster[] = [];

  for (const record of records) {
    const signals = extractSignals(record.content);
    let placed = false;
    for (const signal of signals) {
      const key = `${record.projectId}::${signal}`;
      const existing = bySignal.get(key);
      if (existing) {
        existing.members.push(record);
        placed = true;
        break; // join the first cluster that already exists
      }
    }
    if (!placed) {
      // Create a new cluster under the first signal (or singleton if none).
      const signal = signals[0] ?? '(no-signal)';
      const key = `${record.projectId}::${signal}`;
      const cluster: Cluster = { signal, projectId: record.projectId, members: [record] };
      bySignal.set(key, cluster);
      clusters.push(cluster);
    }
  }
  return clusters;
}
