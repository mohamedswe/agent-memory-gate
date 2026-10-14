/**
 * Candidate writer v2 — turns a redacted promotion candidate + validated
 * reviewer output into an honest MemoryRecord in the owning brain, WITH
 * project identity and a real belongs_to edge to the Project page.
 * Disposable brains only until separately authorized.
 */
import type { RecordService, MemoryRecord } from './records';
import type { Candidate } from './redaction-gate';
import type { ReviewerOutput } from './reviewer-output';
import { validateReviewerOutput } from './reviewer-output';
import { projectSlugFor } from './project-registry';

interface EngineWithLinks {
  addLink(from: string, to: string, context?: string, linkType?: string, linkSource?: string, originSlug?: string, originField?: string, opts?: Record<string, string>): Promise<void>;
}

export async function writeCandidateRecord(
  service: RecordService,
  caller: Parameters<RecordService['create']>[0],
  candidate: Candidate,
  rawReviewerOutput: unknown,
): Promise<MemoryRecord> {
  const output = validateReviewerOutput(rawReviewerOutput, candidate);
  const now = new Date().toISOString();
  const projectId = projectSlugFor(candidate.projectDir);

  const record = await service.create(caller, {
    id: crypto.randomUUID(),
    owner: caller,
    kind: output.memory_kind,
    content: output.content,
    projectId,
    sourceSession: candidate.sessionFile,
    provenance: {
      source: `codex-sessions:${candidate.sessionFile}`,
      eventId: `candidate:${candidate.key}`,
    },
    executionContext: {
      checkoutPath: candidate.projectDir,
    },
    createdAt: now,
    eventAt: now,
    lifecycle: output.lifecycle,       // always 'proposed' by validation
    evidence: output.evidence,         // always 'tentative' by validation
    currency: 'active',
    visibility: 'private',
    crossBrainEligible: false,
    evidencePointers: [
      `usage:userRepeats=${candidate.counts.userRepeats}:agentRediscoveries=${candidate.counts.agentRediscoveries}:rawMentions=${candidate.counts.rawMentions}`,
    ],
  });

  // Real typed edge: record --belongs_to--> project. The Project page may not
  // exist yet when the registry hasn't run; engines reject dangling endpoints,
  // so create the page first if missing (registry-level identity).
  const engine = (service as unknown as { engine: EngineWithLinks }).engine;
  const pageStore = engine as unknown as {
    getPage(slug: string, opts: { sourceId: string }): Promise<unknown>;
    putPage(slug: string, page: Record<string, unknown>, opts: { sourceId: string }): Promise<unknown>;
    addLink(from: string, to: string, context?: string, linkType?: string, linkSource?: string): Promise<void>;
  };
  if (!(await pageStore.getPage(projectId, { sourceId: 'default' }))) {
    await pageStore.putPage(projectId, {
      type: 'project', title: projectId,
      compiled_truth: `Project identity: ${projectId}`,
      frontmatter: {
        visibility: 'private',
        project: { slug: projectId, locations: [candidate.projectDir.replace(/\\/g, '/').replace(/\/+$/, '')] },
      },
    }, { sourceId: 'default' });
  }
  await pageStore.addLink(`records/${record.id}`, projectId, 'record belongs to project', 'belongs_to', 'dual-brain');

  return record;
}
