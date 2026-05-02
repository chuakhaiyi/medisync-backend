/**
 * AI Timetable Generation Service
 *
 * Refactored to leverage the shared LLM Service.
 * This service converts clinical data into structured app tasks.
 */

import { logger } from '../utils/logger';
import { LlmService } from './llm.service';

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

// FIX: Fallback timetable when LLM fails — prevents crash on API timeout/error
function buildFallbackTimetable(input: PatientRecordInput): TimetableResult {
  const tasks: GeneratedTask[] = [];
  let taskIndex = 0;

  // Generate medication tasks from the structured medication data
  for (const med of input.medications) {
    for (const time of med.times) {
      const hour = parseInt(time.split(':')[0], 10);
      const timeOfDay: 'MORNING' | 'AFTERNOON' | 'EVENING' =
        hour < 12 ? 'MORNING' : hour < 17 ? 'AFTERNOON' : 'EVENING';

      tasks.push({
        id: `task_fallback_${Date.now()}_${taskIndex++}`,
        description: `Take ${med.name} ${med.dosage}${med.requiresFood ? ' (with food)' : ''}`,
        timeOfDay,
        scheduledTime: time,
        iconName: 'pill',
        category: 'MEDICATION',
        requiresVitalInput: false,
        templateId: `T_MED_${med.name.replace(/\s+/g, '_').toUpperCase()}`,
        recurrence: 'daily',
        priority: med.criticalMed ? 'CRITICAL' : 'IMPORTANT',
      });
    }
  }

  // Generate tasks from advice items
  for (const advice of input.adviceItems) {
    const timeOfDay = (advice.timeOfDay as 'MORNING' | 'AFTERNOON' | 'EVENING') || 'MORNING';
    const isMonitoring = advice.category === 'MONITORING';

    tasks.push({
      id: `task_fallback_${Date.now()}_${taskIndex++}`,
      description: advice.instruction,
      timeOfDay,
      scheduledTime: advice.scheduledTime || '09:00',
      iconName: advice.category === 'EXERCISE' ? 'walk'
        : advice.category === 'DIET' ? 'food_avoid'
        : advice.category === 'MONITORING' ? 'heart_rate'
        : 'doctor',
      category: advice.category as GeneratedTask['category'],
      requiresVitalInput: isMonitoring,
      vitalType: isMonitoring ? 'bp' : undefined,
      templateId: `T_ADVICE_${taskIndex}`,
      recurrence: 'daily',
      priority: advice.priority as GeneratedTask['priority'],
    });
  }

  return {
    tasks,
    summary: `Fallback timetable generated for ${input.patientName}. ${tasks.length} tasks created from ${input.medications.length} medications and ${input.adviceItems.length} advice items.`,
    generatedAt: new Date().toISOString(),
  };
}

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

  let rawResponse: string;

  try {
    rawResponse = await llm.chat([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ], { response_format: { type: 'json_object' } });
  } catch (llmErr) {
    // FIX: LLM API failure (timeout, rate limit, network) used to throw here
    // and crash the server via unhandled rejection. Now we fall back gracefully.
    logger.error('LLM call failed — using fallback timetable', {
      patientName: input.patientName,
      error: llmErr instanceof Error ? llmErr.message : String(llmErr),
    });
    return buildFallbackTimetable(input);
  }

  // FIX: JSON.parse(rawResponse) was the source of the `"}"` crash.
  // The LLM occasionally returns malformed JSON (truncated, trailing chars).
  // This crashed the .then() handler in records.ts with an unhandled rejection.
  let parsed: { tasks?: any[]; summary?: string };
  try {
    // Strip any accidental markdown fences the LLM may have added
    const cleaned = rawResponse
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    logger.error('LLM returned invalid JSON — using fallback timetable', {
      patientName: input.patientName,
      rawResponse: rawResponse.slice(0, 200), // log first 200 chars for debugging
      error: parseErr instanceof Error ? parseErr.message : String(parseErr),
    });
    return buildFallbackTimetable(input);
  }

  // FIX: Guard against LLM returning valid JSON but missing the tasks array
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    logger.warn('LLM returned empty or missing tasks array — using fallback', {
      patientName: input.patientName,
    });
    return buildFallbackTimetable(input);
  }

  return {
    tasks: parsed.tasks.map((t: any, i: number) => ({
      ...t,
      id: `task_${Date.now()}_${i}`,
      // Ensure required fields have safe defaults if LLM omits them
      timeOfDay: t.timeOfDay || 'MORNING',
      scheduledTime: t.scheduledTime || '08:00',
      iconName: t.iconName || 'pill',
      category: t.category || 'GENERAL',
      requiresVitalInput: t.requiresVitalInput ?? false,
      templateId: t.templateId || `T_TASK_${i}`,
      recurrence: t.recurrence || 'daily',
      priority: t.priority || 'ROUTINE',
    })),
    summary: parsed.summary || `Timetable generated for ${input.patientName}.`,
    generatedAt: new Date().toISOString(),
  };
}
