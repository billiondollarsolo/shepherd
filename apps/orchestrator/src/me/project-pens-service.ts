import { and, eq } from 'drizzle-orm';
import { ProjectPensV1Schema, type ProjectPensResponse, type ProjectPensV1 } from '@flock/shared';
import type { Database } from '../db/client.js';
import { projectPens } from '../db/schema.js';

export class ProjectPensConflictError extends Error {
  constructor(readonly current: ProjectPensResponse) {
    super('Pens changed on another client. Review the latest layout and try again.');
    this.name = 'ProjectPensConflictError';
  }
}

/** Durable, optimistic-concurrency store for one owner's per-project Pens. */
export class ProjectPensService {
  constructor(private readonly db: Database) {}

  async get(userId: string, projectId: string): Promise<ProjectPensResponse> {
    const [row] = await this.db
      .select({ document: projectPens.document, revision: projectPens.revision })
      .from(projectPens)
      .where(and(eq(projectPens.userId, userId), eq(projectPens.projectId, projectId)))
      .limit(1);
    if (!row) return { pens: null, revision: 0 };
    return { pens: ProjectPensV1Schema.parse(row.document), revision: row.revision };
  }

  async put(
    userId: string,
    projectId: string,
    baseRevision: number,
    value: ProjectPensV1,
  ): Promise<ProjectPensResponse> {
    const pens = ProjectPensV1Schema.parse(value);
    const updatedAt = new Date();
    if (baseRevision === 0) {
      const [created] = await this.db
        .insert(projectPens)
        .values({ userId, projectId, document: pens, revision: 1, updatedAt })
        .onConflictDoNothing()
        .returning({ revision: projectPens.revision });
      if (created) return { pens, revision: created.revision };
    } else {
      const [updated] = await this.db
        .update(projectPens)
        .set({ document: pens, revision: baseRevision + 1, updatedAt })
        .where(
          and(
            eq(projectPens.userId, userId),
            eq(projectPens.projectId, projectId),
            eq(projectPens.revision, baseRevision),
          ),
        )
        .returning({ revision: projectPens.revision });
      if (updated) return { pens, revision: updated.revision };
    }
    throw new ProjectPensConflictError(await this.get(userId, projectId));
  }
}
