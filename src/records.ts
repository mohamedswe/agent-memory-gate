export type Owner = 'codex' | 'hermes';
export type NodeKind = 'project' | 'goal' | 'decision' | 'attempt' | 'finding' | 'procedure' | 'evidence';
export interface MemoryRecord {
  id: string;
  owner: Owner;
  kind: NodeKind;
  content: string;
  projectId?: string;
  goalId?: string;
  sourceSession: string;
  provenance: { source: string; eventId: string };
  executionContext: { checkoutPath?: string; agent?: string; branch?: string; commit?: string; dirty?: boolean; environment?: string; preconditions?: string };
  workTypes?: string[];
  createdAt: string;
  eventAt: string;
  verifiedAt?: string;
  evidencePointers?: string[];
  lifecycle: 'proposed' | 'agreed' | 'implemented';
  evidence: 'tentative' | 'verified' | 'contested';
  currency: 'active' | 'superseded' | 'stale';
  visibility: 'private' | 'world';
  crossBrainEligible: boolean;
}
export type RecordInput = Omit<MemoryRecord, 'visibility' | 'crossBrainEligible'> & Partial<Pick<MemoryRecord, 'visibility' | 'crossBrainEligible'>>;
export type SharedRecord = Pick<MemoryRecord, 'id' | 'owner' | 'kind' | 'content' | 'lifecycle' | 'evidence' | 'currency'>;

// Narrow structural interface for Gbrain's exported PGLiteEngine (no vendor import at runtime).
interface PageStore {
  getPage(slug: string, opts: { sourceId: string; includeDeleted?: boolean }): Promise<any>;
  putPage(slug: string, page: { type: string; title: string; compiled_truth: string; frontmatter: Record<string, unknown> }, opts: { sourceId: string }): Promise<unknown>;
  transaction<T>(fn: (tx: PageStore) => Promise<T>): Promise<T>;
}
function assertOwner(owner: unknown): asserts owner is Owner {
  if (owner !== 'codex' && owner !== 'hermes') throw new Error('INVALID_OWNER');
}
function check(condition: unknown): asserts condition {
  if (!condition) throw new Error('INVALID_RECORD');
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
/** Project/goal references are stable slugs: lowercase segments like projects/<name>. */
function slugRef(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/.test(value);
}
function timestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}
function object(value: unknown, keys: string): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  check(Object.keys(value).every(key => keys.split(' ').includes(key)));
}
function validate(record: unknown): asserts record is MemoryRecord {
  object(record, 'id owner kind content projectId goalId sourceSession provenance executionContext workTypes createdAt eventAt verifiedAt evidencePointers lifecycle evidence currency visibility crossBrainEligible');
  check(uuid(record.id));
  check(['project', 'goal', 'decision', 'attempt', 'finding', 'procedure', 'evidence'].includes(record.kind as string));
  check(['proposed', 'agreed', 'implemented'].includes(record.lifecycle as string));
  check(['tentative', 'verified', 'contested'].includes(record.evidence as string));
  check(['active', 'superseded', 'stale'].includes(record.currency as string));
  check(['private', 'world'].includes(record.visibility as string));
  check(typeof record.crossBrainEligible === 'boolean');
  check(text(record.content) && text(record.sourceSession));
  for (const field of ['projectId', 'goalId']) if (record[field] !== undefined) check(slugRef(record[field]));
  object(record.provenance, 'source eventId');
  check(text(record.provenance.source) && text(record.provenance.eventId));
  object(record.executionContext, 'checkoutPath agent branch commit dirty environment preconditions');
  for (const [key, value] of Object.entries(record.executionContext)) {
    check(key === 'dirty' ? typeof value === 'boolean' : text(value));
  }
  check(timestamp(record.createdAt) && timestamp(record.eventAt));
  if (record.verifiedAt !== undefined) check(timestamp(record.verifiedAt));
  for (const field of ['workTypes', 'evidencePointers']) {
    if (record[field] !== undefined) check(Array.isArray(record[field]) && record[field].every(text));
  }
  if (record.evidence === 'verified') {
    // Structural support only: pointers and supplied timestamps do not establish truth.
    check(timestamp(record.verifiedAt) && Array.isArray(record.evidencePointers) && record.evidencePointers.length > 0);
  }
}

// The engine is injected: this module never discovers or opens a database.
export class RecordService {
  constructor(readonly owner: Owner, private readonly engine: PageStore) { assertOwner(owner); }

  async create(caller: Owner, input: RecordInput): Promise<MemoryRecord> {
    assertOwner(caller);
    assertOwner(input?.owner);
    if (caller !== this.owner || input.owner !== this.owner) throw new Error('WRITE_DENIED');
    // Deep clone before validation/storage: nested provenance/context/evidence stay
    // caller-mutable while this async method runs, and the stored page must not
    // alias objects the caller can still mutate (or later mutate through the
    // returned reference). Validation sees the same snapshot that is stored.
    const record = structuredClone({ visibility: 'private', crossBrainEligible: false, ...input }) as MemoryRecord;
    validate(record);
    // Real PGLite serializes transactions, including independent service wrappers.
    await this.engine.transaction(async tx => {
      const slug = `records/${record.id}`;
      if (await tx.getPage(slug, { sourceId: 'default', includeDeleted: true })) {
        throw new Error('RECORD_CONFLICT');
      }
      await tx.putPage(slug, {
        type: 'note', title: record.id, compiled_truth: record.content,
        frontmatter: { visibility: record.visibility, record },
      }, { sourceId: 'default' });
    });
    return record;
  }

  async read(caller: Owner, id: string): Promise<MemoryRecord | SharedRecord | null> {
    assertOwner(caller);
    check(uuid(id));
    const page = await this.engine.getPage(`records/${id}`, { sourceId: 'default' });
    const record = page?.frontmatter.record;
    if (!record) return null;
    if (caller === this.owner) return record;
    if (record.visibility !== 'world' || record.crossBrainEligible !== true) return null;
    const { id: recordId, owner, kind, content, lifecycle, evidence, currency } = record;
    return { id: recordId, owner, kind, content, lifecycle, evidence, currency };
  }
}
