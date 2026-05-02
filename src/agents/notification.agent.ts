import { z } from 'zod';
import { Agent, AgentResponse } from './types';
import { logger } from '../utils/logger';

export const NotificationInputSchema = z.object({
  patientId: z.string().uuid(),
  type: z.enum(['APP_REMINDER', 'SMS', 'EMAIL', 'CLINICIAN_ALERT']),
  message: z.string(),
  priority: z.enum(['LOW', 'NORMAL', 'URGENT', 'CRITICAL']).default('NORMAL'),
});

/**
 * Notification Agent
 * Responsible for delivering messages to patients or clinicians.
 * In this implementation, it mocks the delivery and logs the event.
 */
export class NotificationAgent implements Agent {
  async run(input: z.infer<typeof NotificationInputSchema>): Promise<AgentResponse<any>> {
    try {
      // Mocking notification delivery logic
      logger.info(`Notification sent to ${input.patientId}`, {
        type: input.type,
        priority: input.priority,
        message: input.message
      });

      return {
        success: true,
        data: {
          delivered: true,
          provider: 'MockProvider',
          timestamp: new Date().toISOString()
        }
      };
    } catch (err) {
      logger.error('NotificationAgent failed', { err });
      return { success: false, error: 'Failed to send notification' };
    }
  }
}
