/**
 * LIVE condense pass — clusters the 247 memories deterministically, merges
 * each multi-member cluster into ONE canonical record via the reviewer, and
 * supersedes the variants. Budget-gated, throttled (2s between calls).
 * Authorized: Mohamed, "I will top up", 2026-10-08.
 *
 * Usage: bun scripts/live-condense.ts
 */
import { clusterRecords, CondensableRecord, Cluster } from '../src/condense-cluster';
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

// 1. Load all record pages.
const rows = await engine.executeRaw<{ slug: string; frontmatter: { record: MemoryRecord } }>(
  "SELECT slug, frontmatter FROM pages WHERE slug LIKE 'records/%' AND deleted_at IS NULL",
);
const active = rows.filter(r => r.frontmatter.record.currency === 'active');
console.log(`loaded ${rows.length} records, ${active.length} active`);

// 2. Deterministic clustering.
const condensable: CondensableRecord[] = active.map(r => ({
  slug: r.slug, recordId: r.frontmatter.record.id,
  projectId: r.frontmatter.record.projectId ?? '(none)',
  content: r.frontmatter.record.content,
}));
const clusters = clusterRecords(condensable);
const multi = clusters.filter(c => c.members.length > 1);
const single = clusters.filter(c => c.members.length === 1);
console.log(`clusters: ${clusters.length} total, ${multi.length} need merging (${multi.reduce((s, c) => s + c.members.length, 0)} members), ${single.length} singletons pass through`);

// 3. Merge each multi-member cluster via the reviewer; supersede variants.
const report: { signal: string; merged: string; superseded: string[] }[] = [];
let processed = 0, failures = 0;

for (const cluster of multi) {
  const runKey = `condense-${Date.now()}-${processed++}`;
  try {
    const variants = cluster.members.map(m => m.content).slice(0, 10);
    const prompt = `You are merging near-duplicate project memories. Below are ${variants.length} variants of the same underlying procedure/knowledge from project ${cluster.projectId}. Merge them into ONE canonical statement that keeps all real information (command, path, timeout, working dir) and drops nothing important. Reply with ONLY JSON: {"content": "<=300 chars merged statement", "kind": "procedure|finding", "justification": "<=200 chars"}\n\nVariants:\n${variants.map((v, i) => `${i + 1}. ${v}`).join('\n')}`;

    // Reserve + call (budget-gated):
    const estimate = 0.05;
    const res = ledger.reserve(runKey, estimate);
    if (!res.reserved) { console.log('budget refused — stopping.'); break; }
    const http = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'z-ai/glm-5.3', max_tokens: 1600,
        messages: [
          { role: 'system', content: 'You merge duplicate memories. Reply with only strict JSON. lifecycle is always proposed, evidence always tentative.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    const json = await http.json() as { usage?: { cost?: number }; choices?: { message?: { content?: string; reasoning_content?: string } }[] };
    ledger.reconcile(runKey, typeof json.usage?.cost === 'number' ? json.usage.cost : estimate);

    let content = json.choices?.[0]?.message?.content ?? '';
    if (!content.trim()) {
      const reasoning = json.choices?.[0]?.message?.reasoning_content ?? '';
      const start = reasoning.indexOf('{');
      const end = reasoning.lastIndexOf('}');
      if (start >= 0 && end > start) content = reasoning.slice(start, end + 1);
    }
    const merged = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as { content: string; kind?: string };
    if (!merged.content || merged.content.length > 300) throw new Error('bad merge output');

    // 4. Write canonical record + supersede variants.
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
  } catch (error) {
    failures++;
    console.log(`  cluster failed (${cluster.signal}): ${error instanceof Error ? error.message : error}`);
    if (String(error).includes('BUDGET_REFUSED')) break;
  }
  await new Promise(r => setTimeout(r, 2000)); // throttle: avoid rate limits
  if (processed % 10 === 0) console.log(`progress: ${processed}/${multi.length} | remaining=$${ledger.remainingUsd().toFixed(4)}`);
}

console.log(`\nCONDENSE DONE: merged=${report.length} clusters (from ${multi.length}), failures=${failures}`);
console.log(`records before: ${rows.length} | active after: see inventory`);
console.log(`budget remaining after: $${ledger.remainingUsd().toFixed(4)}`);
writeFileSync(join(OUT_DIR, 'condense-report.jsonl'), report.map(r => JSON.stringify(r)).join('\n') + '\n');
await ledger.close();
await engine.disconnect();
