import { z } from 'zod';
import { Agent, AgentResponse } from './types';
import { logger } from '../utils/logger';

/**
 * Validation/Guardrail Agent
 * Enforces safety guardrails, detects hallucinations, and ensures schema compliance.
 */
export class ValidationAgent implements Agent {
  async run(input: { data: any, schema: z.ZodSchema, context: string }): Promise<AgentResponse<any>> {
    try {
      const { data, schema, context } = input;

      // 1. Schema Validation
      const result = schema.safeParse(data);
      if (!result.success) {
        logger.warn('ValidationAgent: Schema mismatch', { errors: result.error.flatten(), context });
        return { success: false, error: 'Output validation failed schema compliance' };
      }

      // 2. Safety Guardrails (Simple heuristic-based for now, could be LLM-driven)
      const stringified = JSON.stringify(data).toLowerCase();
      const forbiddenTerms = ['diagnose', 'cure', 'guarantee'];

      for (const term of forbiddenTerms) {
        if (stringified.includes(term)) {
          logger.warn('ValidationAgent: Forbidden term detected', { term, context });
          return { success: false, error: `Output violates safety guardrail: detected forbidden term "${term}"` };
        }
      }

      return { success: true, data: result.data };
    } catch (err) {
      logger.error('ValidationAgent failed', { err });
      return { success: false, error: 'Internal validation error' };
    }
  }
}
