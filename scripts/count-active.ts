import { join } from 'node:path';
import { homedir } from 'node:os';
const vendor = join(homedir(), '.bun', 'install', 'global', 'node_modules', 'gbrain');
const fwd = (p: string) => 'file://' + p.split(String.fromCharCode(92)).join('/');
const { configureGateway } = await import(fwd(join(vendor, 'src/core/ai/gateway.ts')));
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
const { PGLiteEngine } = await import(fwd(join(vendor, 'src/core/pglite-engine.ts')));
const engine = new PGLiteEngine();
await engine.connect({ database_path: 'live-run/brain.pglite' });
await engine.initSchema();
const rows = await engine.executeRaw<{ frontmatter: { record: { currency: string } } }>(
  "SELECT frontmatter FROM pages WHERE slug LIKE 'records/%' AND deleted_at IS NULL",
);
const active = rows.filter(r => r.frontmatter.record.currency === 'active').length;
const superseded = rows.filter(r => r.frontmatter.record.currency === 'superseded').length;
console.log(`total: ${rows.length} | ACTIVE: ${active} | superseded: ${superseded}`);
await engine.disconnect();
