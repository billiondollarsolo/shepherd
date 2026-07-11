import {
  ProjectPensResponseSchema,
  type ProjectPensResponse,
  type ProjectPensV1,
} from '@flock/shared';
import { apiRequest } from '../../lib/apiClient';

export async function fetchProjectPens(
  projectId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ProjectPensResponse> {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/pens`, {
    schema: ProjectPensResponseSchema,
    fetchImpl,
    signal,
  });
}

export async function putProjectPens(
  pens: ProjectPensV1,
  baseRevision: number,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ProjectPensResponse> {
  return apiRequest(`/api/projects/${encodeURIComponent(pens.projectId)}/pens`, {
    method: 'PUT',
    body: JSON.stringify({ baseRevision, pens }),
    schema: ProjectPensResponseSchema,
    fetchImpl,
    signal,
    idempotent: true,
    retry: { attempts: 2, baseDelayMs: 200 },
  });
}
