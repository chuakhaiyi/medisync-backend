import { z } from 'zod';
import { Agent, AgentResponse } from './types';
import { prisma } from '../db/client';
import { logger } from '../utils/logger';

export const SchedulingInputSchema = z.object({
  action: z.enum(['BOOK', 'CHECK_AVAILABILITY']),
  patientId: z.string().uuid(),
  doctorId: z.string().uuid(),
  dateTime: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
  type: z.enum(['FOLLOW_UP', 'ROUTINE', 'SPECIALIST', 'EMERGENCY']).optional(),
  notes: z.string().optional(),
});

/**
 * Scheduling Agent
 * Manages appointment bookings and checks for conflicts.
 */
export class SchedulingAgent implements Agent {
  async run(input: z.infer<typeof SchedulingInputSchema>): Promise<AgentResponse<any>> {
    try {
      switch (input.action) {
        case 'CHECK_AVAILABILITY':
          return await this.checkAvailability(input.doctorId, input.dateTime);
        case 'BOOK':
          return await this.bookAppointment(input);
        default:
          return { success: false, error: 'Unsupported action' };
      }
    } catch (err) {
      logger.error('SchedulingAgent failed', { err });
      return { success: false, error: 'Internal scheduling error' };
    }
  }

  private async checkAvailability(doctorId: string, dateTime: string): Promise<AgentResponse<any>> {
    const existing = await prisma.appointment.findFirst({
      where: {
        doctorId,
        dateTime,
        status: { not: 'CANCELLED' }
      }
    });

    return {
      success: true,
      data: { available: !existing }
    };
  }

  private async bookAppointment(input: z.infer<typeof SchedulingInputSchema>): Promise<AgentResponse<any>> {
    // Check for conflict first
    const avail = await this.checkAvailability(input.doctorId, input.dateTime);
    if (!avail.data.available) {
      return { success: false, error: 'Time slot already booked' };
    }

    const appt = await prisma.appointment.create({
      data: {
        patientId: input.patientId,
        doctorId: input.doctorId,
        dateTime: input.dateTime,
        type: input.type || 'FOLLOW_UP',
        status: 'PENDING',
        notes: input.notes,
      }
    });

    return { success: true, data: appt };
  }
}
