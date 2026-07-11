import { parseProjectPens, type ProjectPensV1 } from '@flock/shared';

export async function fetchProjectPens(
  projectId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectPensV1 | null> {
  const response = await fetchImpl(`/api/projects/${encodeURIComponent(projectId)}/pens`, {
    credentials: 'include',
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { pens: unknown };
  return parseProjectPens(body.pens);
}

export async function putProjectPens(
  pens: ProjectPensV1,
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectPensV1 | null> {
  const response = await fetchImpl(`/api/projects/${encodeURIComponent(pens.projectId)}/pens`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pens),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { pens: unknown };
  return parseProjectPens(body.pens);
}
