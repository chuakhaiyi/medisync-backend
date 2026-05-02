/**
 * Hospital Authentication Middleware & Routes
 *
 * Exports:
 *   - AuthenticatedRequest: Extended Request with auth fields
 *   - requireAnyAuth: Middleware that authenticates via JWT or API key
 *   - default (router): Auth routes (hospital register, doctor login)
 */

import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../db/client';
import { logger } from '../utils/logger';

// ── Auth types & middleware (named exports) ─────────────────────────────────

export interface AuthenticatedRequest extends Request {
  hospitalId?: string;
  doctorId?: string;
  userId?: string;
  authMode?: string;
}

export async function requireAnyAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  const apiKey = req.headers['x-api-key'] as string | undefined;

  // Try JWT (Bearer token) first
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
        doctorId?: string;
        hospitalId?: string;
        userId?: string;
      };
      req.doctorId = decoded.doctorId;
      req.hospitalId = decoded.hospitalId;
      req.userId = decoded.userId;
      req.authMode = decoded.userId ? 'jwt_user' : 'jwt_doctor';
      return next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
  }

  // Try API key
  if (apiKey) {
    try {
      const hospitals = await prisma.hospital.findMany({ where: { isActive: true } });
      for (const hospital of hospitals) {
        const match = await bcrypt.compare(apiKey, hospital.apiKeyHash);
        if (match) {
          req.hospitalId = hospital.id;
          req.authMode = 'api_key';
          return next();
        }
      }
      res.status(401).json({ error: 'Invalid API key' });
      return;
    } catch {
      res.status(500).json({ error: 'Authentication failed' });
      return;
    }
  }

  res.status(401).json({ error: 'Authentication required' });
}

// ── Auth routes (default export) ────────────────────────────────────────────

const router = Router();

// POST /api/auth/hospital/register
router.post('/hospital/register', async (req: Request, res: Response): Promise<void> => {
  const adminSecret = req.headers['x-admin-secret'];
  if (adminSecret !== process.env.ADMIN_SECRET) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const { name, address, phone } = req.body;
  if (!name) {
    res.status(400).json({ error: 'Hospital name is required' });
    return;
  }

  try {
    const rawApiKey = `msk_${crypto.randomBytes(32).toString('hex')}`;
    const apiKeyHash = await bcrypt.hash(rawApiKey, 12);

    const hospital = await prisma.hospital.create({
      data: {
        name,
        address,
        phone,
        apiKey: rawApiKey.slice(0, 8),
        apiKeyHash,
      },
    });

    logger.info('New hospital registered', { hospitalId: hospital.id, name });

    res.status(201).json({
      hospitalId: hospital.id,
      name: hospital.name,
      apiKey: rawApiKey,
      warning: 'Store this API key securely. It will not be shown again.',
    });
  } catch (err) {
    logger.error('Hospital registration failed', { err });
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/doctor/login
router.post('/doctor/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password, hospitalId } = req.body;
  if (!email || !password || !hospitalId) {
    res.status(400).json({ error: 'email, password and hospitalId are required' });
    return;
  }

  try {
    const doctor = await prisma.doctor.findFirst({
      where: { email, hospitalId, isActive: true },
    });

    if (!doctor) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    
    const signOptions: SignOptions = {
      expiresIn: 60 * 60 * 8,
    };

    const token = jwt.sign(
      { doctorId: doctor.id, hospitalId: doctor.hospitalId },
      process.env.JWT_SECRET!,
      signOptions
    );

    res.json({
      token,
      doctor: {
        id: doctor.id,
        name: doctor.name,
        role: doctor.role,
        specialty: doctor.specialty,
      },
    });
  } catch (err) {
    logger.error('Doctor login failed', { err });
    res.status(500).json({ error: 'Login failed' });
  }
});

export default router;
