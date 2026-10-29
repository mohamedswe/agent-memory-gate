/**
 * Redaction gate — deterministic, fail-closed pre-filter before any paid
 * inference. Secret-shaped candidates are EXCLUDED (not partially redacted:
 * we do not trust in-place redaction to be complete). Exclusions are always
 * reported with a reason, never silently dropped.
 */

export interface CandidateCounts {
  userRepeats: number;
  agentRediscoveries: number;
  rawMentions: number;
}

export interface Candidate {
  sessionFile: string;
  projectDir: string;
  key: string;
  counts: CandidateCounts;
  sourceKeys?: string[];
  sourceSessions?: string[];
}

export interface ExcludedCandidate {
  candidate: Candidate;
  reason: string;
}

export interface RedactionResult {
  passed: Candidate[];
  excluded: ExcludedCandidate[];
}

export interface RedactionOptions {
  /** Include tool:wait candidates (dead category by default). */
  includeWaitCalls?: boolean;
}

/** Secret shapes — extendable list. Match = exclude the whole candidate. */
const SECRET_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /sk-[A-Za-z0-9]{16,}/, label: 'openai-style api key' },
  { pattern: /ghp_[A-Za-z0-9]{20,}/, label: 'github pat' },
  { pattern: /gho_[A-Za-z0-9]{20,}/, label: 'github oauth token' },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/, label: 'slack token' },
  { pattern: /AKIA[A-Z0-9]{12,}/, label: 'aws access key id' },
  { pattern: /Bearer\s+[A-Za-z0-9._-]{16,}/, label: 'bearer token' },
  { pattern: /(api_key|apikey|token|password|passwd|secret)["']?\s*[:=]\s*["']?[^\s"'&]{6,}/i, label: 'credential assignment' },
];

const CREDENTIAL_PATH = /(?:^|[\s"'=:(]|[\\/])credentials[\\/]/i;

/** True if text contains anything secret-shaped (shared with env-feedback). */
export function containsSecret(text: string): string | null {
  for (const { pattern, label } of SECRET_PATTERNS) if (pattern.test(text)) return label;
  if (CREDENTIAL_PATH.test(text)) return 'credentials path';
  return null;
}

export function redactCandidates(
  input: Candidate[],
  opts: RedactionOptions = {},
): RedactionResult {
  const passed: Candidate[] = [];
  const excluded: ExcludedCandidate[] = [];

  for (const candidate of input) {
    // Category filter: wait calls are a dead category by default.
    if (!opts.includeWaitCalls && candidate.key.startsWith('tool:wait:')) {
      excluded.push({ candidate, reason: 'category: wait-call (disabled by default)' });
      continue;
    }

    // Secret gate: fail-closed on any secret-shaped content.
    let excludedReason: string | null = null;
    const source=[candidate.key,...(candidate.sourceKeys??[])].join('\n');
    if (CREDENTIAL_PATH.test(source)) {
      excludedReason = 'credential path in key';
    } else {
      for (const { pattern, label } of SECRET_PATTERNS) {
        if (pattern.test(source)) {
          excludedReason = `secret shape: ${label}`;
          break;
        }
      }
    }
    if (excludedReason) {
      excluded.push({ candidate, reason: excludedReason });
      continue;
    }

    passed.push(candidate);
  }

  return { passed, excluded };
}
