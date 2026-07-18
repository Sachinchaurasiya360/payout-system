import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { runAdvancePayoutJob } from '../../services/advancePayoutService.js';

export const jobsRouter = Router();

const advanceSchema = z.object({
  // Optional: scope to a single user. Omit to process every eligible sale.
  userId: z.string().min(1).optional(),
});

// Idempotent: safe to POST repeatedly. Already-advanced sales are skipped.
jobsRouter.post(
  '/advance-payout',
  validate(advanceSchema),
  asyncHandler(async (req, res) => {
    const result = await runAdvancePayoutJob({ userId: req.body.userId });
    res.json(result);
  }),
);
