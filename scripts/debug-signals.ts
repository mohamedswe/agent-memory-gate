// Diagnose the skill-path signal extraction on the three test variants.
import { clusterRecords } from '../src/condense-cluster';

const variants = [
  'the graphify skill doc lives at C:\\Users/dev\\.codex\\skills\\graphify\\SKILL.md',
  'agent repeatedly reads the graphify SKILL.md at C:\\Users/dev\\.codex\\skills\\graphify\\SKILL.md',
  'the graphify skill documentation is located at C:\\Users/dev\\.codex\\skills\\graphify\\SKIL',
];
const records = variants.map((content, i) => ({
  slug: `records/d${i}`, recordId: `d${i}`, projectId: 'projects/software-auditor', content,
}));
for (const c of clusterRecords(records)) {
  console.log(`signal: ${JSON.stringify(c.signal)} | members: ${c.members.length}`);
}
