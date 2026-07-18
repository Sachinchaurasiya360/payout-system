import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { settlePayout, listPayouts } from '../../services/payoutService.js';

export const payoutsRouter = Router();

payoutsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ payouts: await listPayouts({ userId: req.query.userId }) });
  }),
);

const settleSchema = z.object({
  status: z.enum(['completed', 'failed', 'cancelled', 'rejected']),
  reason: z.string().max(500).optional(),
});

// Simulates the payment gateway's async webhook. Drives failed-payout recovery.
payoutsRouter.post(
  '/:id/settle',
  validate(settleSchema),
  asyncHandler(async (req, res) => {
    const result = await settlePayout({
      payoutId: req.params.id,
      status: req.body.status,
      reason: req.body.reason,
    });
    res.json(result);
  }),
);
