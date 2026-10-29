import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RecordService } from '../src/records';
import { writeCandidateRecord } from '../src/candidate-writer';
import type { Candidate } from '../src/redaction-gate';
import type { ReviewerOutput } from '../src/reviewer-output';

// Writer: redacted candidate + validated reviewer output -> MemoryRecord in a
// DISPOSABLE PGLite brain via RecordService. Real engine, synthetic data.

const packageDir = process.env.GBRAIN_PACKAGE_DIR;
if (!packageDir) throw new Error('Set GBRAIN_PACKAGE_DIR');
for (const key of Object.keys(process.env)) {
  if (/^(GBRAIN_|DATABASE_URL$|PGHOST$)/.test(key) && key !== 'GBRAIN_PACKAGE_DIR') delete process.env[key];
}
globalThis.fetch = (() => { throw new Error('NETWORK_DISABLED_FOR_TEST'); }) as typeof fetch;
const vendor = createRequire(resolve(packageDir, 'package.json'));
const load = (name: string) => import(pathToFileURL(vendor.resolve(name)).href);
const { configureGateway } = await load('gbrain/ai/gateway');
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
const { PGLiteEngine } = await load('gbrain/pglite-engine');
let engine: any;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120000);
afterAll(async () => { await engine?.disconnect(); }, 30000);

function candidate(): Candidate {
  return {
    sessionFile: 'rollout-synthetic.jsonl',
    projectDir: 'C:/synthetic/checkout-a',
    key: 'tool:exec:input=npm run typecheck',
    counts: { userRepeats: 0, agentRediscoveries: 7, rawMentions: 7 },
  };
}
function reviewerOutput(): ReviewerOutput {
  return {
    memory_kind: 'procedure',
    content: 'Verify loop: npm test then npm run typecheck from the project root.',
    lifecycle: 'proposed',
    evidence: 'tentative',
    justification: 'Agent re-ran the same verify commands 7 times.',
  };
}

test('writer creates an honest tentative proposed record with candidate provenance', async () => {
  const service = new RecordService('codex', engine);
  const record = await writeCandidateRecord(service, 'codex', candidate(), reviewerOutput());

  expect(record.kind).toBe('procedure');
  expect(record.lifecycle).toBe('proposed');
  expect(record.evidence).toBe('tentative');
  expect(record.content).toBe(reviewerOutput().content);
  // Provenance carried from the candidate, not invented:
  expect(record.provenance.eventId).toBe('candidate:tool:exec:input=npm run typecheck');
  expect(record.provenance.source).toBe('codex-sessions:rollout-synthetic.jsonl');
  expect(record.executionContext.checkoutPath).toBe('C:/synthetic/checkout-a');
  expect(record.sourceSession).toBe('rollout-synthetic.jsonl');
  // Usage counts embedded so the reviewer decision is auditable:
  expect(record.evidencePointers).toEqual([
    'usage:userRepeats=0:agentRediscoveries=7:rawMentions=7',
  ]);

  const readBack = await service.read('codex', record.id);
  expect(readBack).not.toBeNull();
  expect((readBack as { content: string }).content).toBe(reviewerOutput().content);
});

test('writer rejects malformed reviewer output before touching the brain', async () => {
  const service = new RecordService('codex', engine);
  const before = await engine.executeRaw('SELECT count(*)::int AS n FROM pages');
  const bad = { ...reviewerOutput(), evidence: 'verified' } as unknown;
  await expect(writeCandidateRecord(service, 'codex', candidate(), bad)).rejects.toThrow();
  const after = await engine.executeRaw('SELECT count(*)::int AS n FROM pages');
  expect((after.rows?.[0] as { n: number })?.n).toBe((before.rows?.[0] as { n: number })?.n);
});

test('normalized candidates retain original source calls and distinct sessions in durable provenance', async () => {
  const service=new RecordService('codex',engine);
  const c={...candidate(),sourceKeys:['tool:exec_command:cmd=bun scripts/test.ts','tool:exec_command:cmd=bun run test'],sourceSessions:['first.jsonl','second.jsonl']};
  const record=await writeCandidateRecord(service,'codex',c,reviewerOutput());
  expect(record.evidencePointers).toContain('source-session:first.jsonl');
  expect(record.evidencePointers).toContain('source-session:second.jsonl');
  expect(record.evidencePointers).toContain('source-call:tool:exec_command:cmd=bun run test');
  const saved=await service.read('codex',record.id);
  expect((saved as typeof record)?.evidencePointers).toEqual(record.evidencePointers);
});
