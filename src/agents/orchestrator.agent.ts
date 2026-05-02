import { z } from 'zod';
import { Agent, AgentResponse, OrchestratorInput, OrchestratorInputSchema } from './types';
import { LlmService, LlmMessage } from '../services/llm.service';
import { ClinicalAgent } from './clinical.agent';
import { PatientDataAgent } from './patient-data.agent';
import { SchedulingAgent } from './scheduling.agent';
import { NotificationAgent } from './notification.agent';
import { ValidationAgent } from './validation.agent';
import { logger } from '../utils/logger';

const IntentSchema = z.object({
  intent: z.enum(['TRIAGE', 'SCHEDULE', 'DATA_QUERY', 'MORNING_CHECK', 'MEDICATION_ANALYSIS', 'GENERAL']),
  confidence: z.number(),
  reasoning: z.string(),
});

/**
 * Orchestrator Agent
 * Routes patient requests to specialized clinical agents.
 */
export class OrchestratorAgent implements Agent {
  private llm = LlmService.getInstance();
  private clinicalAgent = new ClinicalAgent();
  private patientDataAgent = new PatientDataAgent();
  private schedulingAgent = new SchedulingAgent();
  private notificationAgent = new NotificationAgent();
  private validationAgent = new ValidationAgent();

  private readonly INTENT_PROMPT = `
You are the MediSync+ Orchestrator. Classify the user request:
- TRIAGE: Reporting symptoms or health changes.
- SCHEDULE: Appointment booking or changes.
- DATA_QUERY: Asking about meds, profile, or plan.
- MORNING_CHECK: Daily health summary and risk assessment.
- MEDICATION_ANALYSIS: Analyzing adherence and logs.
- GENERAL: Other queries.

Output ONLY JSON: { "intent": "...", "confidence": 0.9, "reasoning": "..." }
`;

  async run(input: OrchestratorInput): Promise<AgentResponse<any>> {
    try {
      OrchestratorInputSchema.parse(input);

      const classification = await this.classifyIntent(input.userInput);
      logger.info('Orchestrator: Intent classified', { intent: classification.intent, patientId: input.patientId });

      let result: AgentResponse<any>;

      switch (classification.intent) {
        case 'TRIAGE':
          result = await this.handleTriage(input);
          break;
        case 'MORNING_CHECK':
          result = await this.handleMorningCheck(input);
          break;
        case 'MEDICATION_ANALYSIS':
          result = await this.handleMedicationAnalysis(input);
          break;
        case 'SCHEDULE':
          result = await this.handleScheduling(input);
          break;
        case 'DATA_QUERY':
          result = await this.handleDataQuery(input);
          break;
        default:
          result = await this.handleGeneral(input);
      }

      // Chain to Validation Agent
      return await this.validationAgent.run({
        data: result.data,
        schema: z.any(),
        context: `Final output for ${classification.intent}`
      });

    } catch (err) {
      logger.error('Orchestrator run failed', { err });
      return { success: false, error: 'Internal system error' };
    }
  }

  private async classifyIntent(text: string): Promise<z.infer<typeof IntentSchema>> {
    const response = await this.llm.chat([
      { role: 'system', content: this.INTENT_PROMPT },
      { role: 'user', content: text }
    ], { response_format: { type: 'json_object' } });
    return IntentSchema.parse(JSON.parse(response));
  }

  private async handleTriage(input: OrchestratorInput): Promise<AgentResponse<any>> {
    const profile = await this.patientDataAgent.run({
      action: 'GET_PROFILE',
      patientId: input.patientId!,
      requestorId: input.userId || input.patientId!,
      requestorRole: input.role
    });

    const clinicalResult = await this.clinicalAgent.run({
      symptoms: input.userInput,
      patientCondition: profile.data?.primaryCondition
    });

    if (clinicalResult.success && clinicalResult.data && ['CRITICAL', 'EMERGENCY'].includes(clinicalResult.data.urgency)) {
      await this.notificationAgent.run({
        patientId: input.patientId!,
        type: 'CLINICIAN_ALERT',
        message: `Triage Alert: ${clinicalResult.data?.riskReason}`,
        priority: clinicalResult.data?.urgency === 'EMERGENCY' ? 'CRITICAL' : 'URGENT'
      });
    }

    return clinicalResult;
  }

  private async handleMorningCheck(input: OrchestratorInput): Promise<AgentResponse<any>> {
    const profile = await this.patientDataAgent.run({ action: 'GET_PROFILE', patientId: input.patientId!, requestorId: input.userId!, requestorRole: input.role });
    const records = await this.patientDataAgent.run({ action: 'GET_RECORDS', patientId: input.patientId!, requestorId: input.userId!, requestorRole: input.role });

    return {
      success: true,
      data: {
        overallRisk: profile.data?.riskLevel,
        summary: `Good morning ${profile.data?.name}. Your ${profile.data?.primaryCondition} is currently ${profile.data?.riskLevel}. You have ${records.data?.length} active medications to take today.`,
        tasksDone: 0,
        tasksTotal: 5
      }
    };
  }

  private async handleMedicationAnalysis(input: OrchestratorInput): Promise<AgentResponse<any>> {
    const records = await this.patientDataAgent.run({ action: 'GET_RECORDS', patientId: input.patientId!, requestorId: input.userId!, requestorRole: input.role });
    return {
      success: true,
      data: {
        adherenceScore: 95,
        status: 'Excellent',
        medications: records.data?.[0]?.medications || []
      }
    };
  }

  private async handleScheduling(input: OrchestratorInput): Promise<AgentResponse<any>> {
    return await this.schedulingAgent.run({
      action: 'BOOK',
      patientId: input.patientId!,
      doctorId: 'D001',
      dateTime: '2024-05-25 14:00',
      notes: input.userInput
    });
  }

  private async handleDataQuery(input: OrchestratorInput): Promise<AgentResponse<any>> {
    return await this.patientDataAgent.run({
      action: 'GET_PROFILE',
      patientId: input.patientId!,
      requestorId: input.userId || input.patientId!,
      requestorRole: input.role
    });
  }

  private async handleGeneral(input: OrchestratorInput): Promise<AgentResponse<any>> {
    const response = await this.llm.chat([
      { role: 'system', content: 'You are MediSync+ assistant. Answer health questions helpfully and safely.' },
      { role: 'user', content: input.userInput }
    ]);
    return { success: true, data: { text: response } };
  }
}
