import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest, requireAnyAuth } from '../middleware/auth';
import { OrchestratorAgent } from '../agents/orchestrator.agent';
import { OrchestratorInputSchema } from '../agents/types';
import { logger } from '../utils/logger';

const router = Router();
const orchestrator = new OrchestratorAgent();

/**
 * POST /api/ai/interact
 * The main entry point for all AI-driven interactions (Chat, Triage, etc.)
 */
router.post(
  '/interact',
  requireAnyAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const input = OrchestratorInputSchema.parse({
        ...req.body,
        userId: req.userId,
        // For simplicity, we assume if it's an app user token, the request is for themselves.
        // If it's a hospital key, we expect patientId in body.
        patientId: req.userId || req.body.patientId,
        role: req.userId ? 'PATIENT' : 'SYSTEM',
      });

      const response = await orchestrator.run(input);

      if (response.success) {
        res.json(response.data);
      } else {
        res.status(422).json({ error: response.error });
      }
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid input', details: err.flatten() });
        return;
      }
      logger.error('AI interaction endpoint failed', { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
