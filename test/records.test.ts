import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dgram from 'node:dgram';

// Install guards BEFORE importing vendor code. No network or inference permitted.
const blocked = () => { throw new Error('NETWORK_DISABLED_FOR_TEST'); };
globalThis.fetch = blocked as any;
net.Socket.prototype.connect = blocked as any;
http.request = http.get = https.request = https.get = blocked as any;
tls.connect = dgram.createSocket = blocked as any;
Bun.connect = blocked as any;
globalThis.WebSocket = blocked as any;
syncBuiltinESMExports();
// Do not let ambient config request a snapshot, repair, or other live database.
for (const key of Object.keys(process.env)) {
  if (/^(GBRAIN_|DATABASE_URL$|PGHOST$)/.test(key) && key !== 'GBRAIN_PACKAGE_DIR') delete process.env[key];
}
const installed = process.env.GBRAIN_PACKAGE_DIR;
if (!installed) throw new Error('Set GBRAIN_PACKAGE_DIR to an installed gbrain package directory');
const vendorRequire = createRequire(resolve(installed, 'package.json'));
const loadVendor = (name: string) => import(pathToFileURL(vendorRequire.resolve(name)).href);
const { configureGateway } = await loadVendor('gbrain/ai/gateway');
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
const { PGLiteEngine } = await loadVendor('gbrain/pglite-engine');
let codexDB: any, hermesDB: any, RecordService: any;
let codex: any, hermes: any;
const time = '2026-10-07T10:00:00.000Z';
function fixture(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(), owner: 'codex', kind: 'decision', content: 'Use synthetic fixtures.',
    sourceSession: 'synthetic-session', provenance: { eventId: 'synthetic-event', source: 'test-fixture' },
    executionContext: { checkoutPath: 'C:/synthetic/checkout-a', agent: 'test-runner' },
    createdAt: time, eventAt: time,
    lifecycle: 'proposed', evidence: 'tentative', currency: 'active',
    ...overrides,
  };
}
beforeAll(async () => {
  codexDB = new PGLiteEngine(); hermesDB = new PGLiteEngine();
  await codexDB.connect({}); await codexDB.initSchema();
  await hermesDB.connect({}); await hermesDB.initSchema();
  const modulePath = '../src/records.ts';
  const module = await import(modulePath).catch(() => ({}));
  RecordService = module.RecordService;
}, 120000);
afterAll(async () => {
  await codexDB?.disconnect(); await hermesDB?.disconnect();
}, 30000);

test('owned records round-trip through separate real page stores', async () => {
  expect(RecordService, 'RecordService export must exist').toBeFunction();
  codex = new RecordService('codex', codexDB);
  hermes = new RecordService('hermes', hermesDB);
  const input = fixture();
  const created = await codex.create('codex', input);
  expect(created).toEqual({ ...input, visibility: 'private', crossBrainEligible: false });
  expect(await codex.read('codex', input.id)).toEqual(created);
  expect(await hermes.read('hermes', input.id)).toBeNull();
  const page = await codexDB.getPage(`records/${input.id}`, { sourceId: 'default' });
  expect(page.compiled_truth).toBe(input.content);
  expect(page.frontmatter.record.owner).toBe('codex');
  const other = fixture({ owner: 'hermes', id: input.id, content: 'Independent Hermes record.' });
  expect((await hermes.create('hermes', other)).owner).toBe('hermes');
  expect((await codex.read('codex', input.id)).content).toBe(input.content);
});

test('cross-brain reads require both opt-ins and expose only a safe projection', async () => {
  for (const [service, owner, outsider] of [[codex, 'codex', 'hermes'], [hermes, 'hermes', 'codex']]) {
    for (const visibility of ['private', 'world']) for (const crossBrainEligible of [false, true]) {
      const input = fixture({ owner, visibility, crossBrainEligible });
      await service.create(owner, input);
      const read = await service.read(outsider, input.id);
      if (visibility === 'world' && crossBrainEligible) {
        expect(read).toEqual({ id: input.id, owner, kind: input.kind, content: input.content,
          lifecycle: 'proposed', evidence: 'tentative', currency: 'active' });
      } else {
        expect(read).toBeNull();
        expect(read).toEqual(await service.read(outsider, crypto.randomUUID()));
      }
      expect((await service.read(owner, input.id)).sourceSession).toBe(input.sourceSession);
    }
  }
});

test('immutable create conflicts even across service wrappers and concurrent requests', async () => {
  const input = fixture();
  await codex.create('codex', input);
  await expect(codex.create('codex', { ...input, content: 'Replacement' })).rejects.toThrow('RECORD_CONFLICT');
  expect((await codex.read('codex', input.id)).content).toBe(input.content);
  const concurrent = fixture();
  const secondWrapper = new RecordService('codex', codexDB);
  const results = await Promise.allSettled([
    codex.create('codex', concurrent),
    secondWrapper.create('codex', { ...concurrent, content: 'Racing replacement' }),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  expect(failure.reason.message).toBe('RECORD_CONFLICT');
});

test('only the two known identities can own a service or call its API', async () => {
  for (const identity of ['other', '', null, undefined, {}, 1]) {
    expect(() => new RecordService(identity, codexDB)).toThrow('INVALID_OWNER');
    const input = fixture({ visibility: 'world', crossBrainEligible: true });
    await codex.create('codex', input);
    await expect(codex.read(identity, input.id)).rejects.toThrow('INVALID_OWNER');
    await expect(codex.create(identity, fixture())).rejects.toThrow('INVALID_OWNER');
    await expect(codex.create('codex', fixture({ owner: identity }))).rejects.toThrow('INVALID_OWNER');
  }
});

test('malformed records are rejected without touching the page store', async () => {
  const invalid = [
    { kind: 'invented' }, { lifecycle: 'done' }, { evidence: 'certain' }, { currency: 'current' },
    { visibility: 'public' }, { crossBrainEligible: 'true' }, { content: '' }, { content: 1 },
    { sourceSession: '' }, { provenance: null }, { provenance: {} },
    { provenance: { source: '', eventId: 'e' } }, { provenance: { source: 's', eventId: [] } },
    { executionContext: [] }, { executionContext: { checkoutPath: 1 } }, { executionContext: { dirty: 'yes' } },
    { createdAt: 'yesterday' }, { eventAt: '2026-02-30T10:00:00.000Z' }, { verifiedAt: 'bad' },
    { projectId: '/checkout/path' }, { goalId: 123 }, { evidencePointers: [null] },
    { workTypes: 'design' }, { unexpectedField: 'reject unknown fields' },
  ];
  for (const override of invalid) {
    const input = fixture(override);
    await expect(codex.create('codex', input)).rejects.toThrow('INVALID_RECORD');
    expect(await codexDB.getPage(`records/${input.id}`, { sourceId: 'default' })).toBeNull();
  }
  for (const id of ['C:/a/project', '../escape', '', 42]) {
    await expect(codex.create('codex', fixture({ id }))).rejects.toThrow('INVALID_RECORD');
    await expect(codex.read('codex', id)).rejects.toThrow('INVALID_RECORD');
  }
});

test('verified requires evidence pointers and a verification timestamp, not a truth guarantee', async () => {
  for (const evidenceFields of [{}, { verifiedAt: time }, { evidencePointers: ['artifact:test-run'] }, { verifiedAt: time, evidencePointers: [] }]) {
    const input = fixture({ evidence: 'verified', ...evidenceFields });
    await expect(codex.create('codex', input)).rejects.toThrow('INVALID_RECORD');
    expect(await codexDB.getPage(`records/${input.id}`, { sourceId: 'default' })).toBeNull();
  }
  const input = fixture({ evidence: 'verified', verifiedAt: time, evidencePointers: ['artifact:synthetic-test-result'],
    projectId: 'projects/synthetic-project', goalId: 'goals/synthetic-goal', workTypes: ['design', 'implementation'] });
  await codex.create('codex', input);
  expect(await codex.read('codex', input.id)).toEqual({ ...input, visibility: 'private', crossBrainEligible: false });
});

test('cross-owner writes are denied before any page mutation', async () => {
  for (const [service, db, owner, outsider] of [[codex, codexDB, 'codex', 'hermes'], [hermes, hermesDB, 'hermes', 'codex']]) {
    const input = fixture({ owner });
    await expect(service.create(outsider, input)).rejects.toThrow('WRITE_DENIED');
    expect(await db.getPage(`records/${input.id}`, { sourceId: 'default' })).toBeNull();
    await expect(service.create(owner, { ...input, owner: outsider })).rejects.toThrow('WRITE_DENIED');
    expect(await db.getPage(`records/${input.id}`, { sourceId: 'default' })).toBeNull();
  }
});
