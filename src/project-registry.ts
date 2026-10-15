/**
 * Project registry — stable project identity from checkout paths.
 * v1: deterministic slug per distinct checkout path (trailing-slash
 * insensitive). A Project page is created in the brain carrying identity +
 * known locations; moves/aliases are a later increment (the design says a
 * moved folder must not create a new project — the alias table comes then).
 */

export interface ProjectIdentity {
  slug: string;
}

/** Deterministic path -> slug: normalize separators + trailing slash, kebab it. */
export function projectSlugFor(checkoutPath: string): string {
  const normalized = checkoutPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const last = normalized.split('/').filter(Boolean).pop() ?? 'unknown';
  const kebab = last.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
  return `projects/${kebab}`;
}

interface PageStore {
  getPage(slug: string, opts: { sourceId: string }): Promise<any>;
  putPage(slug: string, page: Record<string, unknown>, opts: { sourceId: string }): Promise<unknown>;
}

export class ProjectRegistry {
  constructor(private readonly engine: PageStore) {}

  /** Resolve a checkout path to its stable project slug, creating the Project page on first sight. */
  async resolve(checkoutPath: string): Promise<string> {
    const slug = projectSlugFor(checkoutPath);
    const existing = await this.engine.getPage(slug, { sourceId: 'default' });
    if (existing) {
      // Keep the locations list fresh (bounded):
      const locations: string[] = Array.isArray(existing.frontmatter?.project?.locations)
        ? existing.frontmatter.project.locations
        : [];
      const canonical = checkoutPath.replace(/\\/g, '/').replace(/\/+$/, '');
      if (!locations.includes(canonical)) {
        locations.push(canonical);
        await this.engine.putPage(slug, {
          type: 'project', title: slug,
          compiled_truth: `Project identity: ${slug}`,
          frontmatter: { visibility: 'private', project: { slug, locations } },
        }, { sourceId: 'default' });
      }
      return slug;
    }
    await this.engine.putPage(slug, {
      type: 'project', title: slug,
      compiled_truth: `Project identity: ${slug}`,
      frontmatter: {
        visibility: 'private',
        project: { slug, locations: [checkoutPath.replace(/\\/g, '/').replace(/\/+$/, '')] },
      },
    }, { sourceId: 'default' });
    return slug;
  }
}

/** Briefing: project node + all records linked to it — the fresh-session handoff. */
export interface BriefingRecord {
  slug: string;
  kind: string;
  content: string;
  lifecycle: string;
  evidence: string;
  currency: string;
}

export interface ProjectBriefing {
  project: { slug: string; locations: string[] };
  records: BriefingRecord[];
}

interface EngineWithGraph {
  getPage(slug: string, opts: { sourceId: string }): Promise<any>;
  getBacklinks(slug: string, opts: { sourceId: string }): Promise<{ from_slug: string }[]>;
}

export async function projectBriefing(engine: EngineWithGraph, checkoutPath: string): Promise<ProjectBriefing> {
  const slug = projectSlugFor(checkoutPath);
  const page = await engine.getPage(slug, { sourceId: 'default' });
  if (!page) throw new Error(`PROJECT_UNKNOWN: no project at ${checkoutPath}`);
  const backlinks = await engine.getBacklinks(slug, { sourceId: 'default' });
  const records: BriefingRecord[] = [];
  for (const bl of backlinks) {
    const recordPage = await engine.getPage(bl.from_slug, { sourceId: 'default' });
    const rec = recordPage?.frontmatter?.record;
    if (rec) {
      records.push({
        slug: bl.from_slug,
        kind: rec.kind, content: rec.content,
        lifecycle: rec.lifecycle, evidence: rec.evidence, currency: rec.currency,
      });
    }
  }
  return {
    project: { slug, locations: page.frontmatter?.project?.locations ?? [] },
    records,
  };
}
