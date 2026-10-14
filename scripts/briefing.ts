// Dump a per-project briefing from the live disposable brain (read-only).
import { join } from 'node:path';
import { homedir } from 'node:os';
const vendor = join(homedir(), '.bun', 'install', 'global', 'node_modules', 'gbrain');
const fwd = (p: string) => 'file://' + p.split(String.fromCharCode(92)).join('/');
const { configureGateway } = await import(fwd(join(vendor, 'src/core/ai/gateway.ts')));
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
const { PGLiteEngine } = await import(fwd(join(vendor, 'src/core/pglite-engine.ts')));
const { projectBriefing, projectSlugFor } = await import(fwd(join(process.cwd(), 'src/project-registry.ts').replace(String.fromCharCode(92), '/')));

const engine = new PGLiteEngine();
await engine.connect({ database_path: 'live-run/brain.pglite' });
await engine.initSchema();

const target = process.argv[2] ?? process.cwd();
const briefing = await projectBriefing(engine, target);
console.log(`# Briefing for ${briefing.project.slug} (${briefing.records.length} records)`);
console.log(`locations: ${briefing.project.locations.join(', ')}`);
const byKind: Record<string, number> = {};
for (const r of briefing.records) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
console.log('by kind:', JSON.stringify(byKind));
console.log();
for (const r of briefing.records.slice(0, 8)) {
  console.log(`- [${r.kind}] ${r.content.slice(0, 140)}`);
}
if (briefing.records.length > 8) console.log(`  ... and ${briefing.records.length - 8} more`);
await engine.disconnect();
