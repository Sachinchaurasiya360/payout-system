import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { createBrand, listBrands } from '../../services/brandService.js';

export const brandsRouter = Router();

const createBrandSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(128).optional(),
});

brandsRouter.post(
  '/',
  validate(createBrandSchema),
  asyncHandler(async (req, res) => {
    const brand = await createBrand(req.body);
    res.status(201).json({ brand });
  }),
);

brandsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ brands: await listBrands() });
  }),
);
