import { z } from 'zod';

export interface AgentResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: any;
}

export interface Agent {
  run(input: any, context?: any): Promise<AgentResponse<any>>;
}

export const OrchestratorInputSchema = z.object({
  userInput: z.string(),
  patientId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  role: z.enum(['PATIENT', 'DOCTOR', 'SYSTEM']).default('PATIENT'),
});

export type OrchestratorInput = z.infer<typeof OrchestratorInputSchema>;
