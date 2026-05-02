/**
 * Sync Route
 *
 * GET  /api/sync/:appUserId   — Android app polls for pending data (timetable, reminders, etc.)
 * POST /api/sync/:appUserId/ack — App acknowledges receipt of sync items
 *
 * The app identifies itself using a Bearer token (patient JWT issued at login).
 * This endpoint is intentionally read-only from the hospital's perspective.
 */

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db/client';
import { logger } from '../utils/logger';

const router = Router();

function verifyAppToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET!) as { appUserId: string };
    return payload.appUserId;
  } catch {
    return null;
  }
}

// GET /api/sync/:appUserId — Pull pending sync items
router.get('/:appUserId', async (req: Request, res: Response): Promise<void> => {
  const tokenUserId = verifyAppToken(req);
  if (!tokenUserId || tokenUserId !== req.params.appUserId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    // Find the patient linked to this app user
    const patient = await prisma.patient.findUnique({
      where: { appUserId: req.params.appUserId },
    });
    if (!patient) {
      res.status(404).json({ error: 'No linked patient found' });
      return;
    }

    // Get undelivered sync items, oldest first
    const items = await prisma.syncQueueItem.findMany({
      where: { patientId: patient.id, deliveredAt: null },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      take: 20,
    });

    // Mark as attempted
    if (items.length > 0) {
      await prisma.syncQueueItem.updateMany({
        where: { id: { in: items.map(i => i.id) } },
        data: { attempts: { increment: 1 }, lastAttemptAt: new Date() },
      });
    }

    res.json({
      patientId: patient.id,
      items: items.map(item => ({
        id: item.id,
        type: item.itemType,
        priority: item.priority,
        payload: JSON.parse(item.payload),
        createdAt: item.createdAt,
      })),
    });
  } catch (err) {
    logger.error('Sync fetch error', { err });
    res.status(500).json({ error: 'Sync failed' });
  }
});

// POST /api/sync/:appUserId/ack — Acknowledge receipt
router.post('/:appUserId/ack', async (req: Request, res: Response): Promise<void> => {
  const tokenUserId = verifyAppToken(req);
  if (!tokenUserId || tokenUserId !== req.params.appUserId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { itemIds } = req.body as { itemIds: string[] };
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    res.status(400).json({ error: 'itemIds array required' });
    return;
  }

  try {
    await prisma.syncQueueItem.updateMany({
      where: { id: { in: itemIds } },
      data: { deliveredAt: new Date() },
    });
    res.json({ acknowledged: itemIds.length });
  } catch (err) {
    res.status(500).json({ error: 'Ack failed' });
  }
});

export default router;
