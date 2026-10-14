/**
 * LIVE condense retry — re-runs the failed clusters from the condense pass.
 * Same rules: budget-gated, throttled. Authorized under standing paid-call
 * authorization (2026-10-08).
 */
import { clusterRecords, CondensableRecord } from '../src/condense-cluster';
import { BudgetLedger } from '../src/budget-ledger';
import { RecordService, MemoryRecord } from '../src/records';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const OUT_DIR = 'live-run';
const auth = JSON.parse(readFileSync(join(homedir(), '.hermes', 'profiles', 'edge', 'auth.json'), 'utf-8'));
const TOKEN = auth.providers.nous.access_token;
const BASE = auth.providers.nous.inference_base_url;

const ledger = await BudgetLedger.open(join(OUT_DIR, 'ledger.db'), { monthlyCapUsd: 10 });
console.log('budget remaining before:', ledger.remainingUsd().toFixed(4));

const vendor = join(homedir(), '.bun', 'install', 'global', 'node_modules', 'gbrain');
const fwd = (p: string) => 'file://' + p.split(String.fromCharCode(92)).join('/');
const { configureGateway } = await import(fwd(join(vendor, 'src/core/ai/gateway.ts')));
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
const { PGLiteEngine } = await import(fwd(join(vendor, 'src/core/pglite-engine.ts')));
const engine = new PGLiteEngine();
await engine.connect({ database_path: join(OUT_DIR, 'brain.pglite') });
await engine.initSchema();
const service = new RecordService('codex', engine);

const rows = await engine.executeRaw<{ slug: string; frontmatter: { record: MemoryRecord } }>(
  "SELECT slug, frontmatter FROM pages WHERE slug LIKE 'records/%' AND deleted_at IS NULL",
);
const active = rows.filter(r => r.frontmatter.record.currency === 'active');
const condensable: CondensableRecord[] = active.map(r => ({
  slug: r.slug, recordId: r.frontmatter.record.id,
  projectId: r.frontmatter.record.projectId ?? '(none)',
  content: r.frontmatter.record.content,
}));
const clusters = clusterRecords(condensable).filter(c => c.members.length > 1);

// Which clusters already have a canonical record (from the first pass)?
// A cluster is DONE if any member is already superseded.
const supersededIds = new Set(
  rows.filter(r => r.frontmatter.record.currency === 'superseded').map(r => r.frontmatter.record.id),
);
const retry = clusters.filter(c => !c.members.some(m => supersededIds.has(m.recordId)));
console.log(`multi-member clusters: ${clusters.length}, already merged: ${clusters.length - retry.length}, to retry: ${retry.length}`);

const report: { signal: string; merged: string; superseded: string[] }[] = [];
let processed = 0, failures = 0;

for (const cluster of retry) {
  const runKey = `condense2-${Date.now()}-${processed++}`;
  // up to 2 attempts per cluster
  let done = false;
  for (let attempt = 1; attempt <= 2 && !done; attempt++) {
    try {
      const variants = cluster.members.map(m => m.content).slice(0, 10);
      const prompt = `You are merging near-duplicate project memories. Below are ${variants.length} variants of the same underlying knowledge from project ${cluster.projectId}. Merge them into ONE canonical statement keeping all real information (command, path, timeout, working dir). Reply with ONLY JSON, no markdown fences, no prose: {"content": "<=300 chars", "kind": "procedure|finding", "justification": "<=200 chars"}\n\nVariants:\n${variants.map((v, i) => `${i + 1}. ${v}`).join('\n')}`;

      const res = ledger.reserve(runKey + `-a${attempt}`, 0.05);
      if (!res.reserved) { console.log('budget refused — stopping.'); process.exit(0); }
      const http = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'z-ai/glm-5.3', max_tokens: 2400,
          messages: [
            { role: 'system', content: 'Reply with ONLY the JSON object. No reasoning, no fences, no explanation before or after.' },
            { role: 'user', content: prompt },
          ],
        }),
      });
      const json = await http.json() as { usage?: { cost?: number }; choices?: { message?: { content?: string; reasoning_content?: string } }[] };
      ledger.reconcile(runKey + `-a${attempt}`, typeof json.usage?.cost === 'number' ? json.usage.cost : 0.05);

      let content = json.choices?.[0]?.message?.content ?? '';
      if (!content.trim()) {
        const reasoning = json.choices?.[0]?.message?.reasoning_content ?? '';
        const start = reasoning.indexOf('{');
        const end = reasoning.lastIndexOf('}');
        if (start >= 0 && end > start) content = reasoning.slice(start, end + 1);
      }
      const merged = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as { content: string; kind?: string };
      if (!merged.content || merged.content.length > 300) throw new Error('bad merge output');

      const first = cluster.members[0];
      const originalFirst = rows.find(r => r.frontmatter.record.id === first.recordId)!.frontmatter.record;
      const canonical = await service.create('codex', {
        id: crypto.randomUUID(), owner: 'codex',
        kind: (merged.kind === 'finding' ? 'finding' : 'procedure') as 'finding' | 'procedure',
        content: merged.content,
        projectId: cluster.projectId === '(none)' ? undefined : cluster.projectId,
        sourceSession: originalFirst.sourceSession,
        provenance: { source: 'condense-merge', eventId: `merge:${cluster.members.map(m => m.recordId).join(',')}` },
        executionContext: originalFirst.executionContext,
        createdAt: new Date().toISOString(), eventAt: new Date().toISOString(),
        lifecycle: 'proposed', evidence: 'tentative', currency: 'active',
        evidencePointers: [`merge:${cluster.members.length} variants`],
      });
      for (const member of cluster.members) {
        const variantRow = rows.find(r => r.frontmatter.record.id === member.recordId)!;
        const variant = variantRow.frontmatter.record;
        variant.currency = 'superseded';
        await engine.putPage(variantRow.slug, {
          type: 'note', title: variant.id, compiled_truth: variant.content,
          frontmatter: { visibility: variant.visibility, record: variant },
        }, { sourceId: 'default' });
        await engine.addLink(`records/${canonical.id}`, variantRow.slug, 'canonical supersedes variant', 'supersedes', 'dual-brain');
      }
      report.push({ signal: cluster.signal, merged: merged.content, superseded: cluster.members.map(m => m.recordId) });
      done = true;
    } catch (error) {
      if (attempt === 2) {
        failures++;
        console.log(`  cluster failed (${cluster.signal.slice(0, 50)}): ${error instanceof Error ? error.message : error}`);
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  await new Promise(r => setTimeout(r, 2000));
}

console.log(`\nRETRY DONE: merged=${report.length}, failures=${failures}`);
console.log(`budget remaining after: $${ledger.remainingUsd().toFixed(4)}`);
writeFileSync(join(OUT_DIR, 'condense-retry-report.jsonl'), report.map(r => JSON.stringify(r)).join('\n') + '\n');
await ledger.close();
await engine.disconnect();
