/**
 * AI Timetable Generation Service
 *
 * Refactored to leverage the shared LLM Service.
 * This service converts clinical data into structured app tasks.
 */

import { logger } from '../utils/logger';
import { LlmService } from './llm.service';

const LLM_MODEL = process.env.LLM_MODEL || 'llama-3.3-70b-versatile';

export interface GeneratedTask {
  id: string;
  description: string;
  timeOfDay: 'MORNING' | 'AFTERNOON' | 'EVENING';
  scheduledTime: string;
  iconName: string;
  category: 'MEDICATION' | 'EXERCISE' | 'DIET' | 'MONITORING' | 'APPOINTMENT' | 'GENERAL';
  requiresVitalInput: boolean;
  vitalType?: string;
  templateId: string;
  recurrence: 'daily' | 'weekly' | 'once';
  priority: 'ROUTINE' | 'IMPORTANT' | 'CRITICAL';
}

export interface TimetableResult {
  tasks: GeneratedTask[];
  summary: string;
  generatedAt: string;
}

interface PatientRecordInput {
  patientName: string;
  primaryCondition: string;
  medications: Array<{
    name: string;
    dosage: string;
    times: string[];
    instructions?: string;
    requiresFood: boolean;
    criticalMed: boolean;
    frequency: string;
  }>;
  adviceItems: Array<{
    category: string;
    instruction: string;
    timing?: string;
    timeOfDay?: string;
    scheduledTime?: string;
    frequency: string;
    priority: string;
  }>;
  nextAppointmentDate?: string;
  nextAppointmentTime?: string;
  nextAppointmentType?: string;
  nextAppointmentNotes?: string;
  restrictions?: {
    diet?: string[];
    activity?: string[];
  };
}

const SYSTEM_PROMPT = `You are a clinical care coordinator AI for MediSync+, a post-discharge patient care app.
Your task is to generate a structured daily timetable (as checklist tasks) based on a doctor's patient care record.
You must output ONLY valid JSON — no markdown, no explanation, no preamble.

Icon names must be one of: pill, walk, food_avoid, scale, heart_rate, calendar, water, sleep, doctor, exercise.

Output JSON schema:
{
  "tasks": [{
    "description": "string",
    "timeOfDay": "MORNING|AFTERNOON|EVENING",
    "scheduledTime": "HH:mm",
    "iconName": "string",
    "category": "MEDICATION|EXERCISE|DIET|MONITORING|APPOINTMENT|GENERAL",
    "requiresVitalInput": boolean,
    "vitalType": "string?",
    "templateId": "string",
    "recurrence": "daily|weekly|once",
    "priority": "ROUTINE|IMPORTANT|CRITICAL"
  }],
  "summary": "string"
}`;

export async function generateTimetable(input: PatientRecordInput): Promise<TimetableResult> {
  const llm = LlmService.getInstance();

  const userPrompt = `Generate a daily timetable for this patient care record:

Patient: ${input.patientName}
Condition: ${input.primaryCondition}

MEDICATIONS:
${input.medications.map((m, i) =>
  `${i + 1}. ${m.name} ${m.dosage} — Times: ${m.times.join(', ')}`
).join('\n')}

DOCTOR'S ADVICE:
${input.adviceItems.map((a, i) =>
  `${i + 1}. [${a.category}] ${a.instruction}`
).join('\n')}

RESTRICTIONS: ${JSON.stringify(input.restrictions)}`;

  logger.info('Generating timetable using LLM service', { patientName: input.patientName });

  const rawResponse = await llm.chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ], { response_format: { type: 'json_object' } });

  const parsed = JSON.parse(rawResponse);

  return {
    tasks: parsed.tasks.map((t: any, i: number) => ({
      ...t,
      id: `task_${Date.now()}_${i}`
    })),
    summary: parsed.summary,
    generatedAt: new Date().toISOString(),
  };
}
