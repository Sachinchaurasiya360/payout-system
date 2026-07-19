import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { runAdvancePayoutJob } from '../../services/advancePayoutService.js';

export const jobsRouter = Router();

const advanceSchema = z.object({
  userId: z.string().min(1).optional(),
});

jobsRouter.post(
  '/advance-payout',
  validate(advanceSchema),
  asyncHandler(async (req, res) => {
    const result = await runAdvancePayoutJob({ userId: req.body.userId });
    res.json(result);
  }),
);
