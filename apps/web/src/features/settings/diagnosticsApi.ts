import { FlockDiagnosticsSchema, type FlockDiagnostics } from '@flock/shared';
import { apiRequest } from '../../lib/apiClient';

export async function fetchDiagnostics(fetchImpl: typeof fetch = fetch): Promise<FlockDiagnostics> {
  return apiRequest('/api/diagnostics', {
    method: 'GET',
    schema: FlockDiagnosticsSchema,
    fetchImpl,
    idempotent: true,
    retry: { attempts: 1 },
  });
}
