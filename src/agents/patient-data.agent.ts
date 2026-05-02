import { z } from 'zod';
import { Agent, AgentResponse } from './types';
import { prisma } from '../db/client';
import { decryptPHI, encryptPHI } from '../utils/encryption';
import { logger } from '../utils/logger';

export const PatientDataInputSchema = z.object({
  action: z.enum(['GET_PROFILE', 'UPDATE_RISK', 'GET_RECORDS']),
  patientId: z.string().uuid(),
  requestorId: z.string().uuid(),
  requestorRole: z.enum(['PATIENT', 'DOCTOR', 'SYSTEM']),
  data: z.any().optional(),
});

/**
 * Patient Data Agent
 * Handles all access to PHI.
 * Enforces Role-Based Access Control (RBAC) and handles encryption/decryption.
 */
export class PatientDataAgent implements Agent {
  async run(input: z.infer<typeof PatientDataInputSchema>): Promise<AgentResponse<any>> {
    try {
      // 1. RBAC Check
      if (input.requestorRole === 'PATIENT' && input.requestorId !== input.patientId) {
        return { success: false, error: 'Forbidden: Patients can only access their own data' };
      }

      switch (input.action) {
        case 'GET_PROFILE':
          return await this.getPatientProfile(input.patientId);
        case 'UPDATE_RISK':
          if (input.requestorRole === 'PATIENT') return { success: false, error: 'Unauthorized: Patients cannot update risk level' };
          return await this.updateRiskLevel(input.patientId, input.data.riskLevel);
        case 'GET_RECORDS':
          return await this.getPatientRecords(input.patientId);
        default:
          return { success: false, error: 'Unsupported action' };
      }
    } catch (err) {
      logger.error('PatientDataAgent failed', { err, patientId: input.patientId });
      return { success: false, error: 'Internal data processing error' };
    }
  }

  private async getPatientProfile(id: string): Promise<AgentResponse<any>> {
    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient) return { success: false, error: 'Patient not found' };

    // Decrypt PHI before returning to other agents (internal use)
    return {
      success: true,
      data: {
        ...patient,
        name: decryptPHI(patient.nameEncrypted),
        contact: patient.contactEncrypted ? decryptPHI(patient.contactEncrypted) : null,
      }
    };
  }

  private async updateRiskLevel(id: string, riskLevel: string): Promise<AgentResponse<any>> {
    const updated = await prisma.patient.update({
      where: { id },
      data: { riskLevel }
    });
    return { success: true, data: updated };
  }

  private async getPatientRecords(patientId: string): Promise<AgentResponse<any>> {
    const records = await prisma.patientRecord.findMany({
      where: { patientId, isActive: true },
      include: { medications: true, adviceItems: true }
    });
    return { success: true, data: records };
  }
}
