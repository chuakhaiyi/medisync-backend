import { z } from 'zod';
import { Agent, AgentResponse } from './types';
import { LlmService, LlmMessage } from '../services/llm.service';
import { logger } from '../utils/logger';

export const TimetableInputSchema = z.object({
  patientName: z.string(),
  primaryCondition: z.string(),
  medications: z.array(z.any()),
  adviceItems: z.array(z.any()),
  restrictions: z.any().optional(),
});

export const TimetableOutputSchema = z.object({
  tasks: z.array(z.object({
    description: z.string(),
    timeOfDay: z.enum(['MORNING', 'AFTERNOON', 'EVENING']),
    scheduledTime: z.string().regex(/^\d{2}:\d{2}$/),
    iconName: z.string(),
    category: z.enum(['MEDICATION', 'EXERCISE', 'DIET', 'MONITORING', 'APPOINTMENT', 'GENERAL']),
    requiresVitalInput: z.boolean(),
    vitalType: z.string().nullable().optional(),
    templateId: z.string(),
    recurrence: z.enum(['daily', 'weekly', 'once']),
    priority: z.enum(['ROUTINE', 'IMPORTANT', 'CRITICAL']),
  })),
  summary: z.string(),
});

/**
 * Timetable Agent
 * Converts complex clinical instructions into a structured patient schedule.
 */
export class TimetableAgent implements Agent {
  private llm = LlmService.getInstance();

  private readonly SYSTEM_PROMPT = `
You are a Clinical Care Coordinator AI for MediSync+.
Your goal is to generate a structured daily timetable (checklist tasks) based on a doctor's care record.

RULES:
1. Convert every medication into one task per scheduled time.
2. Assign morning (06-12), afternoon (12-18), or evening (18-24) based on scheduledTime.
3. Identify monitoring tasks (e.g., "weigh yourself") and set requiresVitalInput=true and vitalType (weight|bp|etc).
4. Use patient-friendly descriptions.
5. Icon names: pill, walk, food_avoid, scale, heart_rate, calendar, water, sleep, doctor, exercise.

Output MUST be valid JSON.
`;

  async run(input: z.infer<typeof TimetableInputSchema>): Promise<AgentResponse<z.infer<typeof TimetableOutputSchema>>> {
    try {
      const userPrompt = `
Generate a daily timetable for:
Patient: ${input.patientName}
Condition: ${input.primaryCondition}
Medications: ${JSON.stringify(input.medications)}
Advice: ${JSON.stringify(input.adviceItems)}
Restrictions: ${JSON.stringify(input.restrictions)}
`;

      const messages: LlmMessage[] = [
        { role: 'system', content: this.SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ];

      const response = await this.llm.chat(messages, { response_format: { type: 'json_object' } });
      const parsed = TimetableOutputSchema.parse(JSON.parse(response));

      return { success: true, data: parsed };
    } catch (err) {
      logger.error('TimetableAgent failed', { err });
      return { success: false, error: 'Failed to generate timetable' };
    }
  }
}
