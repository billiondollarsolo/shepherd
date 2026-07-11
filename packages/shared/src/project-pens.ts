import { z } from 'zod';
import { ProjectLayoutV1Schema } from './project-layout.js';

export const ProjectPenV1Schema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  layout: ProjectLayoutV1Schema,
});
export type ProjectPenV1 = z.infer<typeof ProjectPenV1Schema>;

export const ProjectPensV1Schema = z.object({
  version: z.literal(1),
  projectId: z.string().min(1),
  activePenId: z.string().min(1),
  pens: z.array(ProjectPenV1Schema),
});
export type ProjectPensV1 = z.infer<typeof ProjectPensV1Schema>;

export function parseProjectPens(raw: unknown): ProjectPensV1 | null {
  const parsed = ProjectPensV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
