/**
 * Patients Routes
 *
 * POST /api/patients              — Register a new patient (hospital side)
 * GET  /api/patients              — List patients for the hospital
 * GET  /api/patients/:id          — Get patient details
 * POST /api/patients/:id/link-app — Link patient to their Android app account
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../db/client';
import { AuthenticatedRequest, requireAnyAuth } from '../middleware/auth';
import { auditLog } from '../middleware/auditLog';
import { encryptPHI, safeDecryptPHI } from '../utils/encryption';
import { logger } from '../utils/logger';

const router = Router();

const CreatePatientSchema = z.object({
  mrn: z.string().min(1),
  name: z.string().min(1),
  age: z.number().int().positive(),
  bloodType: z.string().optional(),
  allergies: z.array(z.string()).optional(),
  phone: z.string().optional(),
  emergencyContact: z.string().optional(),
  primaryCondition: z.string().min(1),
  riskLevel: z.enum(['STABLE', 'WARNING', 'CRITICAL']).default('STABLE'),
});

// POST /api/patients
router.post(
  '/',
  requireAnyAuth,
  auditLog('CREATE_PATIENT', 'Patient'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const parsed = CreatePatientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;

    try {
      // Check MRN uniqueness within hospital
      const existing = await prisma.patient.findFirst({
        where: { hospitalId: req.hospitalId, mrn: data.mrn },
      });
      if (existing) {
        res.status(409).json({ error: `Patient with MRN ${data.mrn} already exists` });
        return;
      }

      const patient = await prisma.patient.create({
        data: {
          id: uuidv4(),
          hospitalId: req.hospitalId!,
          mrn: data.mrn,
          nameEncrypted: encryptPHI(data.name),
          age: data.age,
          bloodType: data.bloodType,
          allergiesJson: data.allergies ? encryptPHI(JSON.stringify(data.allergies)) : null,
          contactEncrypted: data.phone ? encryptPHI(data.phone) : null,
          emergencyContactEncrypted: data.emergencyContact ? encryptPHI(data.emergencyContact) : null,
          primaryCondition: data.primaryCondition,
          riskLevel: data.riskLevel,
        },
      });

      res.status(201).json({
        success: true,
        patientId: patient.id,
        mrn: patient.mrn,
      });
    } catch (err) {
      logger.error('Failed to create patient', { err });
      res.status(500).json({ error: 'Failed to create patient' });
    }
  }
);

// GET /api/patients
router.get(
  '/',
  requireAnyAuth,
  auditLog('LIST_PATIENTS', 'Patient'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const patients = await prisma.patient.findMany({
        where: { hospitalId: req.hospitalId, isActive: true },
        select: {
          id: true,
          mrn: true,
          nameEncrypted: true,
          age: true,
          primaryCondition: true,
          riskLevel: true,
          appUserId: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      // Decrypt names for response
      const result = patients.map(p => ({
        ...p,
        name: safeDecryptPHI(p.nameEncrypted) ?? '[Encrypted]',
        nameEncrypted: undefined,
      }));

      res.json({ patients: result, total: result.length });
    } catch (err) {
      logger.error('Failed to list patients', { err });
      res.status(500).json({ error: 'Failed to list patients' });
    }
  }
);

// GET /api/patients/:id
router.get(
  '/:id',
  requireAnyAuth,
  auditLog('VIEW_PATIENT', 'Patient'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const patient = await prisma.patient.findFirst({
        where: { id: req.params.id, hospitalId: req.hospitalId },
      });
      if (!patient) {
        res.status(404).json({ error: 'Patient not found' });
        return;
      }

      res.json({
        id: patient.id,
        mrn: patient.mrn,
        name: safeDecryptPHI(patient.nameEncrypted),
        age: patient.age,
        bloodType: patient.bloodType,
        allergies: safeDecryptPHI(patient.allergiesJson),
        phone: safeDecryptPHI(patient.contactEncrypted),
        primaryCondition: patient.primaryCondition,
        riskLevel: patient.riskLevel,
        appLinked: !!patient.appUserId,
      });
    } catch (err) {
      logger.error('Failed to fetch patient', { err });
      res.status(500).json({ error: 'Failed to fetch patient' });
    }
  }
);

// POST /api/patients/:id/link-app — Link hospital patient to app user ID
router.post(
  '/:id/link-app',
  requireAnyAuth,
  auditLog('LINK_APP', 'Patient'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { appUserId } = req.body;
    if (!appUserId) {
      res.status(400).json({ error: 'appUserId is required' });
      return;
    }
    try {
      await prisma.patient.update({
        where: { id: req.params.id },
        data: { appUserId },
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to link app user' });
    }
  }
);

export default router;
