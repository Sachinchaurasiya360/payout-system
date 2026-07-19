import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { createUser, listUsers, getUserByHandleOrId, serializeUser } from '../../services/userService.js';
import { initiateWithdrawal } from '../../services/withdrawalService.js';
import { getLedger, listPayouts } from '../../services/payoutService.js';

export const usersRouter = Router();

const createUserSchema = z.object({ handle: z.string().min(1).max(64) });

usersRouter.post(
  '/',
  validate(createUserSchema),
  asyncHandler(async (req, res) => {
    const user = await createUser(req.body);
    res.status(201).json({ user: serializeUser(user) });
  }),
);

usersRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ users: await listUsers() });
  }),
);

usersRouter.get(
  '/:handle',
  asyncHandler(async (req, res) => {
    const user = await getUserByHandleOrId(req.params.handle);
    res.json({ user: serializeUser(user) });
  }),
);

const withdrawalSchema = z.object({
  // Omit `amount` to withdraw the full available balance.
  amount: z.number().positive().optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

usersRouter.post(
  '/:handle/withdrawals',
  validate(withdrawalSchema),
  asyncHandler(async (req, res) => {
    const result = await initiateWithdrawal({
      userId: req.params.handle,
      amount: req.body.amount,
      idempotencyKey: req.body.idempotencyKey,
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }),
);

usersRouter.get(
  '/:handle/payouts',
  asyncHandler(async (req, res) => {
    const payouts = await listPayouts({ userId: req.params.handle });
    res.json({ payouts });
  }),
);

usersRouter.get(
  '/:handle/ledger',
  asyncHandler(async (req, res) => {
    const ledger = await getLedger(req.params.handle);
    res.json({ ledger });
  }),
);
