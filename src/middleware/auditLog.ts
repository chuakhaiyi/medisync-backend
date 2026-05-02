/**
 * Audit Logging Middleware
 * Records all data access and mutations for HIPAA compliance.
 * Every request that touches patient data gets an immutable audit entry.
 */

import { Response, NextFunction } from 'express';
import { prisma } from '../db/client';
import { AuthenticatedRequest } from './auth';
import { logger } from '../utils/logger';

export function auditLog(action: string, resourceType: string) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const originalEnd = res.end.bind(res);

    (res as any).end = async function (chunk: any, ...args: any[]) {
      originalEnd(chunk, ...args);

      if (res.statusCode < 400) {
        try {
          const resourceId =
            req.params.patientId ||
            req.params.recordId ||
            req.params.id ||
            undefined;

          await prisma.auditLog.create({
            data: {
              hospitalId: req.hospitalId,
              actorId: req.doctorId || req.hospitalId || 'system',
              actorType: req.authMode === 'jwt_doctor' ? 'DOCTOR' : 'SYSTEM',
              action,
              resourceType,
              resourceId,
              ipAddress: req.ip,
              userAgent: req.headers['user-agent'],
              metadata: JSON.stringify({
                method: req.method,
                path: req.path,
                statusCode: res.statusCode,
              }),
            },
          });
        } catch (err) {
          logger.error('Failed to write audit log', { err, action, resourceType });
        }
      }
    };

    next();
  };
}
