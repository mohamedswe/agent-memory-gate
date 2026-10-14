// Full memory inventory: every record in the disposable brain, grouped by project.
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

const records = await engine.executeRaw<{ frontmatter: { record: Record<string, unknown> } }>(
  "SELECT frontmatter FROM pages WHERE slug LIKE 'records/%' AND deleted_at IS NULL",
);
const byProject: Record<string, unknown[]> = {};
for (const r of records) {
  const rec = r.frontmatter.record;
  const p = String(rec.projectId ?? '(none)');
  (byProject[p] ??= []).push(rec);
}
console.log(`TOTAL: ${records.length} memories\n`);
for (const [p, recs] of Object.entries(byProject).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`## ${p} — ${recs.length} memories`);
  for (const rec of recs as { kind: string; content: string }[]) {
    console.log(`  [${rec.kind}] ${rec.content.slice(0, 110)}`);
  }
  console.log();
}
await engine.disconnect();
