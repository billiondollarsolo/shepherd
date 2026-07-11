import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_USER_PREFERENCES,
  UserPreferencesValueV1Schema,
  type UserPreferencesDocument,
  type UserPreferencesValueV1,
} from '@flock/shared';
import type { Database } from '../db/client.js';
import { userPreferences } from '../db/schema.js';

export class UserPreferencesConflictError extends Error {
  constructor(readonly current: UserPreferencesDocument) {
    super('Preferences changed on another client. Reload and try again.');
    this.name = 'UserPreferencesConflictError';
  }
}

export class UserPreferencesService {
  constructor(private readonly db: Database) {}

  async get(userId: string): Promise<UserPreferencesDocument> {
    const [row] = await this.db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    if (!row) return { ...DEFAULT_USER_PREFERENCES, revision: 0, updatedAt: null };
    const value = UserPreferencesValueV1Schema.parse(row.document);
    return { ...value, revision: row.revision, updatedAt: row.updatedAt.toISOString() };
  }

  async put(
    userId: string,
    baseRevision: number,
    value: UserPreferencesValueV1,
  ): Promise<UserPreferencesDocument> {
    const document = UserPreferencesValueV1Schema.parse(value);
    const updatedAt = new Date();
    if (baseRevision === 0) {
      const [created] = await this.db
        .insert(userPreferences)
        .values({ userId, document, revision: 1, updatedAt })
        .onConflictDoNothing()
        .returning();
      if (created) return { ...document, revision: 1, updatedAt: updatedAt.toISOString() };
    } else {
      const [updated] = await this.db
        .update(userPreferences)
        .set({ document, revision: baseRevision + 1, updatedAt })
        .where(and(eq(userPreferences.userId, userId), eq(userPreferences.revision, baseRevision)))
        .returning();
      if (updated) {
        return {
          ...document,
          revision: updated.revision,
          updatedAt: updated.updatedAt.toISOString(),
        };
      }
    }
    throw new UserPreferencesConflictError(await this.get(userId));
  }
}
