/**
 * Project layout REST client (Phase 3).
 */
import { parseProjectLayout, type ProjectLayoutV1 } from '@flock/shared';

export async function fetchProjectLayout(
  projectId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectLayoutV1 | null> {
  const res = await fetchImpl(`/api/projects/${encodeURIComponent(projectId)}/layout`, {
    credentials: 'include',
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { layout: unknown };
  return parseProjectLayout(body.layout);
}

export async function putProjectLayout(
  layout: ProjectLayoutV1,
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectLayoutV1 | null> {
  const res = await fetchImpl(`/api/projects/${encodeURIComponent(layout.projectId)}/layout`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(layout),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { layout: unknown };
  return parseProjectLayout(body.layout);
}
