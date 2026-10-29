/** Offline exploratory replay; does not change the production gate or treatment. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve('.eval-local/value-codex-v3');
const ledger = JSON.parse(readFileSync(join(root, 'cross-session.json'), 'utf8'));
const observed = ledger.sessions['trial/project'] as Record<string, string[]>;
const original: Record<string, string[]> = Object.fromEntries(Object.entries(observed).filter(([k])=>k.startsWith('tool:exec_command:cmd=')));
const script = JSON.parse(readFileSync('.eval-local/value-v1/source/package.json','utf8')).scripts.test;
const normalized = new Map<string, Set<string>>();
const transformations: unknown[] = [];
for (const [key, sessions] of Object.entries(original)) {
  const shell = key.slice('tool:exec_command:cmd='.length);
  const at = shell.indexOf(' -Command ');
  let body = at < 0 ? shell : shell.slice(at + ' -Command '.length).trim();
  if ((body.startsWith("'") && body.endsWith("'")) || (body.startsWith('"') && body.endsWith('"'))) body = body.slice(1,-1);
  // Intentionally restricted to simple observed commands. This is not a shell parser.
  const parts=body.split(';').map(p=>p.trim());
  const actions=parts.map(part=>{
    const read=part.match(/^Get-Content\s+(?:(?:-LiteralPath|-Path)\s+)?([\w./-]+)$/i);
    if(read)return `read-file:${read[1]}`;
    if(part===script || part==='bun run test')return `package-script:test:${script}`;
    return null;
  });
  const identities=actions.every(Boolean)?actions as string[]:[key];
  transformations.push({original:key,sessions,identities,supported:actions.every(Boolean)});
  for(const identity of identities){const seen=normalized.get(identity)??new Set<string>();sessions.forEach(s=>seen.add(s));normalized.set(identity,seen);}
}
const repeated=[...normalized].filter(([,sessions])=>sessions.size>=2).map(([identity,sessions])=>({identity,sessions:[...sessions]}));
const result={
  label:'Exploratory, offline, post-observation normalization replay; not a measured treatment',
  originalUniqueCommandKeys:Object.keys(original).length,
  originalRepeatedCommandKeys:Object.values(original).filter(s=>new Set(s).size>=2).length,
  hypotheticalRepeatedActions:repeated.length,repeated,transformations,
  limitations:['Only simple observed read commands and the repo-declared test-script alias are handled.',
    'Repeated actions are candidates, not validated useful memories.',
    'No downstream inference, recall, or development improvement has been evaluated.',
    'The active nine-run treatment remains unchanged and empty.'],
};
mkdirSync('experiments/run-09-data',{recursive:true});
writeFileSync('experiments/run-09-data/gate-replay.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({originalRepeatedCommandKeys:result.originalRepeatedCommandKeys,hypotheticalRepeatedActions:repeated.length,repeated}));
