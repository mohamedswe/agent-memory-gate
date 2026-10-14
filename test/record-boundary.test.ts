import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RecordService } from '../src/records';

// A real database boundary regression, independent of the main scenario order.
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

test('create snapshots nested input before yielding to the database', async () => {
  const service = new RecordService('codex', engine);
  const input = {
    id: crypto.randomUUID(), owner: 'codex' as const, kind: 'finding' as const,
    content: 'Synthetic boundary finding', sourceSession: 'synthetic',
    provenance: { source: 'synthetic-tool', eventId: 'original-event' },
    executionContext: { checkoutPath: 'C:/synthetic/original' },
    createdAt: '2026-10-07T00:00:00.000Z', eventAt: '2026-10-07T00:00:00.000Z',
    lifecycle: 'implemented' as const, evidence: 'verified' as const, currency: 'active' as const,
    verifiedAt: '2026-10-07T00:00:00.000Z', evidencePointers: ['synthetic:original'],
  };
  const expected = structuredClone(input);
  const writing = service.create('codex', input);
  input.provenance.eventId = 'changed-after-validation';
  input.executionContext.checkoutPath = 'C:/synthetic/changed';
  input.evidencePointers.length = 0;
  await writing;
  const stored = await service.read('codex', input.id);
  expect(stored).toMatchObject(expected);
});
