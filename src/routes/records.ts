/**
 * Patient Records Routes
 *
 * POST /api/records           — Doctor submits a new care record (medications + advice + appointment)
 * GET  /api/records/:patientId — Get the active record for a patient
 * PUT  /api/records/:recordId  — Update an existing record
 *
 * On record creation/update, the AI timetable is auto-generated and pushed to the sync queue.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client';
import { AuthenticatedRequest, requireAnyAuth } from '../middleware/auth';
import { auditLog } from '../middleware/auditLog';
import { generateTimetable } from '../services/timetableService';
import { safeDecryptPHI } from '../utils/encryption';
import { logger } from '../utils/logger';

const router = Router();

// ── Validation schemas ──────────────────────────────────────────────────────
const MedicationSchema = z.object({
  name: z.string().min(1),
  dosage: z.string().min(1),
  medicationClass: z.string().optional(),
  frequency: z.enum(['once_daily', 'twice_daily', 'thrice_daily', 'as_needed']),
  times: z.array(z.string().regex(/^\d{2}:\d{2}$/)).min(1),
  instructions: z.string().optional(),
  requiresFood: z.boolean().default(false),
  criticalMed: z.boolean().default(false),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sideEffects: z.string().optional(),
  pillColorHex: z.string().optional(),
});

const AdviceSchema = z.object({
  category: z.enum(['EXERCISE', 'DIET', 'MONITORING', 'MEDICATION', 'GENERAL']),
  instruction: z.string().min(1),
  timing: z.string().optional(),
  timeOfDay: z.enum(['MORNING', 'AFTERNOON', 'EVENING', 'ANY']).optional(),
  scheduledTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  frequency: z.string().default('daily'),
  durationDays: z.number().int().positive().optional(),
  priority: z.enum(['ROUTINE', 'IMPORTANT', 'CRITICAL']).default('ROUTINE'),
  notes: z.string().optional(),
});

const CreateRecordSchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid(),
  recordType: z.enum(['DISCHARGE', 'FOLLOW_UP', 'ROUTINE_VISIT', 'SPECIALIST_CONSULT']),
  medications: z.array(MedicationSchema).min(0),
  adviceItems: z.array(AdviceSchema).min(0),
  nextAppointmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  nextAppointmentTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  nextAppointmentType: z.enum(['FOLLOW_UP', 'ROUTINE', 'SPECIALIST', 'EMERGENCY']).optional(),
  nextAppointmentNotes: z.string().optional(),
  diagnosisSummary: z.string().optional(),
  treatmentSummary: z.string().optional(),
  dischargeNotes: z.string().optional(),
  restrictionsDiet: z.array(z.string()).optional(),
  restrictionsActivity: z.array(z.string()).optional(),
  followUpInstructions: z.string().optional(),
});

// ── POST /api/records — Create a new patient care record ────────────────────
router.post(
  '/',
  requireAnyAuth,
  auditLog('CREATE_RECORD', 'PatientRecord'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const parsed = CreateRecordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;

    try {
      // Verify patient belongs to this hospital
      const patient = await prisma.patient.findFirst({
        where: { id: data.patientId, hospitalId: req.hospitalId },
      });
      if (!patient) {
        res.status(404).json({ error: 'Patient not found in your hospital' });
        return;
      }

      // Verify doctor belongs to this hospital
      const doctor = await prisma.doctor.findFirst({
        where: { id: data.doctorId, hospitalId: req.hospitalId },
      });
      if (!doctor) {
        res.status(404).json({ error: 'Doctor not found in your hospital' });
        return;
      }

      // Deactivate any existing active records for this patient
      await prisma.patientRecord.updateMany({
        where: { patientId: data.patientId, isActive: true },
        data: { isActive: false },
      });

      // Create new record with medications and advice in a transaction
      const record = await prisma.$transaction(async (tx) => {
        const newRecord = await tx.patientRecord.create({
          data: {
            patientId: data.patientId,
            doctorId: data.doctorId,
            recordType: data.recordType,
            nextAppointmentDate: data.nextAppointmentDate,
            nextAppointmentTime: data.nextAppointmentTime,
            nextAppointmentType: data.nextAppointmentType,
            nextAppointmentNotes: data.nextAppointmentNotes,
            diagnosisSummary: data.diagnosisSummary,
            treatmentSummary: data.treatmentSummary,
            dischargeNotes: data.dischargeNotes,
            restrictionsJson: JSON.stringify({
              diet: data.restrictionsDiet || [],
              activity: data.restrictionsActivity || [],
            }),
            followUpInstructions: data.followUpInstructions,
          },
        });

        // Insert medications
        if (data.medications.length > 0) {
          await tx.medication.createMany({
            data: data.medications.map(m => ({
              recordId: newRecord.id,
              name: m.name,
              dosage: m.dosage,
              medicationClass: m.medicationClass,
              frequency: m.frequency,
              times: JSON.stringify(m.times),
              instructions: m.instructions,
              requiresFood: m.requiresFood,
              criticalMed: m.criticalMed,
              startDate: m.startDate,
              endDate: m.endDate,
              sideEffects: m.sideEffects,
              pillColorHex: m.pillColorHex,
            })),
          });
        }

        // Insert advice items
        if (data.adviceItems.length > 0) {
          await tx.doctorAdvice.createMany({
            data: data.adviceItems.map(a => ({
              recordId: newRecord.id,
              category: a.category,
              instruction: a.instruction,
              timing: a.timing,
              timeOfDay: a.timeOfDay,
              scheduledTime: a.scheduledTime,
              frequency: a.frequency,
              durationDays: a.durationDays,
              priority: a.priority,
              notes: a.notes,
            })),
          });
        }

        // Auto-create appointment if next appointment specified
        if (data.nextAppointmentDate) {
          await tx.appointment.create({
            data: {
              patientId: data.patientId,
              doctorId: data.doctorId,
              dateTime: `${data.nextAppointmentDate} ${data.nextAppointmentTime || '09:00'}`,
              type: data.nextAppointmentType || 'FOLLOW_UP',
              status: 'CONFIRMED',
              notes: data.nextAppointmentNotes,
            },
          });
        }

        return newRecord;
      });

      // Generate AI timetable asynchronously (non-blocking)
      const patientName = safeDecryptPHI(patient.nameEncrypted) || 'Patient';
      const restrictions = data.restrictionsDiet || data.restrictionsActivity
        ? { diet: data.restrictionsDiet, activity: data.restrictionsActivity }
        : undefined;

      generateTimetable({
        patientName,
        primaryCondition: patient.primaryCondition,
        medications: data.medications.map(m => ({
          name: m.name,
          dosage: m.dosage,
          times: m.times,
          instructions: m.instructions,
          requiresFood: m.requiresFood,
          criticalMed: m.criticalMed,
          frequency: m.frequency,
        })),
        adviceItems: data.adviceItems,
        nextAppointmentDate: data.nextAppointmentDate,
        nextAppointmentTime: data.nextAppointmentTime,
        nextAppointmentType: data.nextAppointmentType,
        nextAppointmentNotes: data.nextAppointmentNotes,
        restrictions,
      })
        .then(async (timetable) => {
          // Push timetable to sync queue for the Android app to pull
          await prisma.syncQueueItem.create({
            data: {
              patientId: data.patientId,
              itemType: 'TIMETABLE',
              payload: JSON.stringify({
                recordId: record.id,
                tasks: timetable.tasks,
                summary: timetable.summary,
                generatedAt: timetable.generatedAt,
                appointmentDate: data.nextAppointmentDate,
                appointmentTime: data.nextAppointmentTime,
              }),
              priority: 'NORMAL',
            },
          });
          logger.info('Timetable queued for patient', { patientId: data.patientId });
        })
        .catch(err => {
          logger.error('Timetable generation failed', { err, recordId: record.id });
        });

      res.status(201).json({
        success: true,
        recordId: record.id,
        message: 'Patient record created. AI timetable generation in progress.',
      });
    } catch (err) {
      logger.error('Failed to create patient record', { err });
      res.status(500).json({ error: 'Failed to create patient record' });
    }
  }
);

// ── GET /api/records/:patientId — Get active record ─────────────────────────
router.get(
  '/:patientId',
  requireAnyAuth,
  auditLog('VIEW_RECORD', 'PatientRecord'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const patient = await prisma.patient.findFirst({
        where: { id: req.params.patientId, hospitalId: req.hospitalId },
      });
      if (!patient) {
        res.status(404).json({ error: 'Patient not found' });
        return;
      }

      const record = await prisma.patientRecord.findFirst({
        where: { patientId: req.params.patientId, isActive: true },
        include: { medications: true, adviceItems: true },
      });

      if (!record) {
        res.status(404).json({ error: 'No active record found for patient' });
        return;
      }

      res.json({ record });
    } catch (err) {
      logger.error('Failed to fetch patient record', { err });
      res.status(500).json({ error: 'Failed to fetch record' });
    }
  }
);

export default router;
