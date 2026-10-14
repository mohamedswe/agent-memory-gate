import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RecordService } from '../src/records';
import { ProjectRegistry, projectBriefing } from '../src/project-registry';
import { writeCandidateRecord } from '../src/candidate-writer';
import type { Candidate } from '../src/redaction-gate';

// Project registry + writer v2 — stable project identity from checkout paths,
// real belongs_to edges, and the project briefing for fresh sessions.

const packageDir = process.env.GBRAIN_PACKAGE_DIR;
if (!packageDir) throw new Error('Set GBRAIN_PACKAGE_DIR');
for (const key of Object.keys(process.env)) {
  if (/^(GBRAIN_|DATABASE_URL$|PGHOST$)/.test(key) && key !== 'GBRAIN_PACKAGE_DIR') delete process.env[key];
}
globalThis.fetch = (() => { throw new Error('NETWORK_DISABLED_FOR_TEST'); }) as typeof fetch;
const vendor = createRequire(resolve(packageDir!, 'package.json'));
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

function candidate(dir = 'C:/synthetic/checkout-a'): Candidate {
  return {
    sessionFile: 'rollout-synthetic.jsonl',
    projectDir: dir,
    key: 'tool:exec:input=npm run typecheck',
    counts: { userRepeats: 0, agentRediscoveries: 3, rawMentions: 3 },
  };
}
function reviewerOutput(content: string) {
  return {
    memory_kind: 'procedure',
    content,
    lifecycle: 'proposed',
    evidence: 'tentative',
    justification: 'synthetic test',
  };
}

test('same checkout path maps to one stable project id; different paths stay distinct', async () => {
  const reg = new ProjectRegistry(engine);
  const a1 = await reg.resolve('C:/synthetic/checkout-a');
  const a1Again = await reg.resolve('C:/synthetic/checkout-a/');
  const b = await reg.resolve('C:/synthetic/checkout-b');

  expect(a1Again).toBe(a1);
  expect(b).not.toBe(a1);
  expect(a1).toMatch(/^projects\/checkout-a$/);

  const page = await engine.getPage('projects/checkout-a', { sourceId: 'default' });
  expect(page).not.toBeNull();
  expect(page.frontmatter.project.locations).toContain('C:/synthetic/checkout-a');
});

test('writer v2 creates the record WITH projectId and a real belongs_to edge', async () => {
  const service = new RecordService('codex', engine);
  const record = await writeCandidateRecord(service, 'codex', candidate(), reviewerOutput('Verify loop for checkout-a.'));

  // Project identity on the record itself:
  expect(record.projectId).toBe('projects/checkout-a');

  // Real typed edge in the links table:
  const links = await engine.getLinks(`records/${record.id}`, { sourceId: 'default' });
  expect(links.some((l: { to_slug: string; link_type: string }) =>
    l.to_slug === 'projects/checkout-a' && l.link_type === 'belongs_to',
  )).toBe(true);
});

test('projectBriefing packs the project orientation and its linked records', async () => {
  const service = new RecordService('codex', engine);
  // second record for the same project through the same real path:
  await writeCandidateRecord(
    service, 'codex',
    { ...candidate(), key: 'tool:exec:input=npm test', counts: { userRepeats: 0, agentRediscoveries: 2, rawMentions: 2 } },
    reviewerOutput('Second synthetic decision for checkout-a.'),
  );

  const briefing = await projectBriefing(engine, 'C:/synthetic/checkout-a');
  expect(briefing.project.slug).toBe('projects/checkout-a');
  expect(briefing.records.length).toBeGreaterThanOrEqual(2);
  const contents = briefing.records.map((r: { content: string }) => r.content);
  expect(contents.some((c: string) => c.includes('Verify loop'))).toBe(true);
  expect(contents.some((c: string) => c.includes('Second synthetic'))).toBe(true);
});
