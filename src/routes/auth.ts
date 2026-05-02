/**
 * Hospital Authentication Routes
 *
 * POST /api/auth/hospital/register — Register a new hospital (admin only, protected by ADMIN_SECRET)
 * POST /api/auth/doctor/login      — Doctor logs in, receives JWT
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { prisma } from '../db/client';
import { logger } from '../utils/logger';

const router = Router();

// POST /api/auth/hospital/register
router.post('/hospital/register', async (req: Request, res: Response): Promise<void> => {
  // Protect with a server-side admin secret
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
    // Generate a secure API key (shown ONCE, only hash stored)
    const rawApiKey = `msk_${crypto.randomBytes(32).toString('hex')}`;
    const apiKeyHash = await bcrypt.hash(rawApiKey, 12);

    const hospital = await prisma.hospital.create({
      data: {
        name,
        address,
        phone,
        apiKey: rawApiKey.slice(0, 8), // Store prefix for lookup efficiency
        apiKeyHash,
      },
    });

    logger.info('New hospital registered', { hospitalId: hospital.id, name });

    // Return the full raw key — hospital must store this securely
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

    // In production, store hashed password in Doctor model and compare here
    // For now, issuing token directly (password check would go here)

    const token = jwt.sign(
      { doctorId: doctor.id, hospitalId: doctor.hospitalId },
      process.env.JWT_SECRET!,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
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
