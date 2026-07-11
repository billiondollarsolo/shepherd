import { z } from 'zod';
import { ProjectAgentPolicySchema, ProjectSchema, Uuid } from '../domain.js';

// --- projects --------------------------------------------------------------

/** GET /api/projects?nodeId=... */
export const ListProjectsQuery = z.object({ nodeId: Uuid.optional() });
export type ListProjectsQuery = z.infer<typeof ListProjectsQuery>;
export const ListProjectsResponse = z.object({ projects: z.array(ProjectSchema) });
export type ListProjectsResponse = z.infer<typeof ListProjectsResponse>;

/** POST /api/projects */
export const CreateProjectRequest = z.object({
  nodeId: Uuid,
  name: z.string().min(1),
  workingDir: z.string().min(1),
  agentPolicy: ProjectAgentPolicySchema.optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;
export const ProjectResponse = z.object({ project: ProjectSchema });
export type ProjectResponse = z.infer<typeof ProjectResponse>;

export const UpdateProjectAgentPolicyRequest = ProjectAgentPolicySchema;
export type UpdateProjectAgentPolicyRequest = z.infer<typeof UpdateProjectAgentPolicyRequest>;
