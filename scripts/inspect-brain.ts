// Inspect records in the disposable brain (read-only).
import { join } from 'node:path';
import { homedir } from 'node:os';
const vendor = join(homedir(), '.bun', 'install', 'global', 'node_modules', 'gbrain');
const fwd = (p: string) => 'file://' + p.replace(/\\/g, '/');
const { configureGateway } = await import(fwd(join(vendor, 'src/core/ai/gateway.ts')));
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
const { PGLiteEngine } = await import(fwd(join(vendor, 'src/core/pglite-engine.ts')));
const engine = new PGLiteEngine();
await engine.connect({ database_path: 'live-run/brain.pglite' });
await engine.initSchema();
const rows = await engine.executeRaw<{ slug: string; title: string }>(
  'SELECT slug, title FROM pages WHERE deleted_at IS NULL',
);
console.log('pages:', rows.length);
for (const r of rows) console.log('-', r.slug, '|', r.title);
await engine.disconnect();
