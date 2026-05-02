/**
 * Authentication Middleware
 *
 * Three authentication modes:
 * 1. Hospital API Key  — for hospital EMR systems
 * 2. Doctor JWT Token  — for the hospital dashboard web UI
 * 3. App User JWT      — for the patient Android app
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../db/client';
import { logger } from '../utils/logger';

export interface AuthenticatedRequest extends Request {
  hospitalId?: string;
  doctorId?: string;
  userId?: string; // patientId/appUserId
  role?: 'PATIENT' | 'DOCTOR' | 'SYSTEM';
  authMode?: 'api_key' | 'jwt_doctor' | 'jwt_app';
}

/**
 * Validates X-Hospital-API-Key header.
 */
export async function requireHospitalApiKey(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const apiKey = req.headers['x-hospital-api-key'] as string | undefined;
  if (!apiKey) {
    res.status(401).json({ error: 'Missing X-Hospital-API-Key header' });
    return;
  }

  try {
    const hospitals = await prisma.hospital.findMany({
      where: { isActive: true },
      select: { id: true, apiKeyHash: true },
    });

    let matchedHospitalId: string | null = null;
    for (const h of hospitals) {
      if (await bcrypt.compare(apiKey, h.apiKeyHash)) {
        matchedHospitalId = h.id;
        break;
      }
    }

    if (!matchedHospitalId) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    req.hospitalId = matchedHospitalId;
    req.role = 'SYSTEM';
    req.authMode = 'api_key';
    next();
  } catch (err) {
    logger.error('Auth middleware error', { err });
    res.status(500).json({ error: 'Authentication error' });
  }
}

/**
 * Validates Bearer JWT token (Doctor or App User).
 */
export function requireJwt(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;

    if (payload.doctorId) {
      req.doctorId = payload.doctorId;
      req.hospitalId = payload.hospitalId;
      req.role = 'DOCTOR';
      req.authMode = 'jwt_doctor';
    } else if (payload.appUserId) {
      req.userId = payload.appUserId;
      req.role = 'PATIENT';
      req.authMode = 'jwt_app';
    }

    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Accepts any valid authentication.
 */
export async function requireAnyAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const apiKey = req.headers['x-hospital-api-key'];
  if (apiKey) {
    return requireHospitalApiKey(req, res, next);
  }
  return requireJwt(req, res, next) as unknown as void;
}
