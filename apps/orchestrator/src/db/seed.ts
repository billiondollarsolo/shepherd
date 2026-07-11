/**
 * Flock — optional DEV seed data (spec §6, US-2).
 *
 * NOT run in production. Guarded by NODE_ENV !== 'production'. Intended for
 * local paddock development so the UI has something to render. Inserts a local
 * node -> project -> agent_session chain demonstrating the single authoritative
 * session record (one id threads tmux name + hook token hash + CDP endpoint).
 */
import { pathToFileURL } from 'node:url';

import { createDb } from './client.js';
import type { Database } from './client.js';
import { agentSessions, nodes, projects, users } from './schema.js';

export async function seed(db: Database): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed in production.');
  }

  const [admin] = await db
    .insert(users)
    .values({
      username: 'admin',
      // Placeholder hash; real argon2id hashing lands in US-4. Dev-only.
      passwordHash: 'dev-placeholder-not-a-real-hash',
      role: 'admin',
    })
    .returning();

  const [node] = await db
    .insert(nodes)
    .values({
      name: 'local',
      kind: 'local',
      connectionStatus: 'connected',
      createdBy: admin?.id ?? null,
    })
    .returning();

  if (!node) throw new Error('[seed] failed to insert node');

  const [project] = await db
    .insert(projects)
    .values({
      nodeId: node.id,
      name: 'flock',
      workingDir: '/home/flock/work/flock',
    })
    .returning();

  if (!project) throw new Error('[seed] failed to insert project');

  await db.insert(agentSessions).values({
    nodeId: node.id,
    projectId: project.id,
    agentType: 'claude-code',
    tmuxSessionName: 'flock-dev-1',
    workingDir: project.workingDir,
    hookTokenHash: 'dev-hook-token-hash-please-rotate',
    status: 'idle',
    createdBy: admin?.id ?? null,
  });
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  const { db, pool } = createDb();
  seed(db)
    .then(async () => {
      // eslint-disable-next-line no-console
      console.log('[seed] dev data inserted');
      await pool.end();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[seed] failed', err);
      await pool.end();
      process.exit(1);
    });
}
