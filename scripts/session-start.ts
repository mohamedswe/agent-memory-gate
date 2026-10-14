/**
 * session-start.ts — the fresh-session handoff. Given a project directory,
 * renders the active memories for that project as a compact briefing Codex
 * (or any agent) can load at session start.
 *
 * Location: C:\Users/dev\Development\Local\dual-brain-memory\scripts\session-start.ts
 *
 * Usage:
 *   bun C:/Users/dev/Development/Local/dual-brain-memory/scripts/session-start.ts <project-dir>
 *   bun C:/Users/dev/Development/Local/dual-brain-memory/scripts/session-start.ts <project-dir> --stdout
 *
 * Default: writes the briefing to <project-dir>/.project-memory/BRIEFING.md
 * (relative to the target project, NOT this repo) and prints the path.
 * --stdout: prints the briefing to stdout instead.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const targetDir = process.argv[2];
if (!targetDir) {
  console.error('usage: bun session-start.ts <project-dir> [--stdout]');
  process.exit(1);
}
const toStdout = process.argv.includes('--stdout');

const vendor = join(homedir(), '.bun', 'install', 'global', 'node_modules', 'gbrain');
const fwd = (p: string) => 'file://' + p.split(String.fromCharCode(92)).join('/');
const { configureGateway } = await import(fwd(join(vendor, 'src/core/ai/gateway.ts')));
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
const { PGLiteEngine } = await import(fwd(join(vendor, 'src/core/pglite-engine.ts')));

const BRAIN_PATH = join(homedir(), 'Development', 'Local', 'dual-brain-memory', 'live-run', 'brain.pglite');
const engine = new PGLiteEngine();
await engine.connect({ database_path: BRAIN_PATH });
await engine.initSchema();

// Load this project's active records via the belongs_to graph:
const { projectSlugFor } = await import(fwd(join(homedir(), 'Development', 'Local', 'dual-brain-memory', 'src', 'project-registry.ts').replace(String.fromCharCode(92), '/')));
const slug = projectSlugFor(targetDir);
const projectPage = await engine.getPage(slug, { sourceId: 'default' });
if (!projectPage) {
  console.log(`No memories yet for project ${slug}. Nothing to brief.`);
  await engine.disconnect();
  process.exit(0);
}
const backlinks = await engine.getBacklinks(slug, { sourceId: 'default' });
const actives: { kind: string; content: string; createdAt?: string; sourceSession?: string }[] = [];
for (const bl of backlinks) {
  const page = await engine.getPage(bl.from_slug, { sourceId: 'default' });
  const rec = page?.frontmatter?.record;
  if (rec && rec.currency === 'active') actives.push({ kind: rec.kind, content: rec.content, createdAt: rec.createdAt, sourceSession: rec.sourceSession });
}

// Render: procedures first (how to work here), then findings (what to know).
const procedures = actives.filter(a => a.kind === 'procedure');
const findings = actives.filter(a => a.kind === 'finding');
const others = actives.filter(a => a.kind !== 'procedure' && a.kind !== 'finding' && a.kind !== 'attempt');

const lines = [
  `# Project memory — ${slug}`,
  ``,
  `Learned from ${'your'} past sessions in this project. Trust these over re-deriving them, but verify anything that looks stale.`,
  ``,
  `## How to work here (${procedures.length} procedures)`,
  ...procedures.map(p => `- ${p.content}`),
  ...(findings.length ? ['', `## Things to know (${findings.length} findings)`, ...findings.map(f => `- ${f.content}`)] : []),
  ...(others.length ? ['', `## Other (${others.length})`, ...others.map(o => `- ${o.content}`)] : []),
  '',
];
const briefing = lines.join('\n');

// HISTORY.md — the marker lane (satisfaction transitions), alongside the briefing.
const { renderHistoryMarkdown } = await import(fwd(join(homedir(), 'Development', 'Local', 'dual-brain-memory', 'src', 'history-renderer.ts').replace(String.fromCharCode(92), '/')));
const history = renderHistoryMarkdown(slug, actives.map(a => ({
  kind: a.kind, content: a.content,
  createdAt: a.createdAt ?? '', sessionFile: a.sourceSession ?? 'unknown',
})));

if (toStdout) {
  console.log(briefing);
  console.log('--- HISTORY ---');
  console.log(history);
} else {
  const outDir = join(targetDir, '.project-memory');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'BRIEFING.md');
  writeFileSync(outPath, briefing);
  const historyPath = join(outDir, 'HISTORY.md');
  writeFileSync(historyPath, history);
  console.log(outPath);
  console.log(historyPath);
}
await engine.disconnect();
