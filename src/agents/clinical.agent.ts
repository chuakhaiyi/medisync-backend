import { z } from 'zod';
import { Agent, AgentResponse } from './types';
import { LlmService, LlmMessage } from '../services/llm.service';
import { logger } from '../utils/logger';

export const ClinicalInputSchema = z.object({
  symptoms: z.string(),
  patientCondition: z.string().optional(),
});

export const ClinicalOutputSchema = z.object({
  urgency: z.enum(['STABLE', 'WARNING', 'CRITICAL', 'EMERGENCY']),
  recommendedAction: z.string(),
  riskReason: z.string(),
  agentNotes: z.string(),
});

/**
 * Clinical/Triage Agent
 * Responsible for assessing symptoms and providing triage guidance.
 * Adheres to safety guardrails: Never provides a definitive medical diagnosis.
 */
export class ClinicalAgent implements Agent {
  private llm = LlmService.getInstance();

  private readonly SYSTEM_PROMPT = `
You are a Clinical Triage Assistant for MediSync+.
Your goal is to assess patient symptoms and determine the appropriate urgency level.

URGENCY LEVELS:
- EMERGENCY: Immediate life-threatening situation (e.g., severe chest pain, inability to breathe).
- CRITICAL: Requires immediate medical attention within hours.
- WARNING: Concerning changes that require contact with the care team today.
- STABLE: Minor symptoms that can be monitored.

GUIDELINES:
1. NEVER provide a definitive medical diagnosis.
2. Use clinical logic based on the patient's existing condition if provided.
3. Always lean towards caution.
4. Output MUST be a structured JSON object matching the requested schema.

RESPONSE FORMAT (JSON):
{
  "urgency": "STABLE | WARNING | CRITICAL | EMERGENCY",
  "recommendedAction": "Clear instruction for the patient",
  "riskReason": "Clinical justification for the urgency level",
  "agentNotes": "Internal notes for the care team"
}
`;

  async run(input: z.infer<typeof ClinicalInputSchema>): Promise<AgentResponse<z.infer<typeof ClinicalOutputSchema>>> {
    try {
      const userPrompt = `
Patient Condition: ${input.patientCondition || 'Unknown'}
Reported Symptoms: ${input.symptoms}
`;

      const messages: LlmMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ];

      const response = await this.llm.chat(messages, { response_format: { type: 'json_object' } });
      const parsed = ClinicalOutputSchema.parse(JSON.parse(response));

      return { success: true, data: parsed };
    } catch (err) {
      logger.error('ClinicalAgent execution failed', { err });
      return {
        success: false,
        error: 'Clinical assessment failed',
        data: {
          urgency: 'WARNING',
          recommendedAction: 'Contact your care team as a precaution.',
          riskReason: 'Agent processing error, falling back to safe default.',
          agentNotes: 'Internal error during clinical agent run.'
        }
      };
    }
  }
}
