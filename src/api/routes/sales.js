import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import {
  createSale,
  getSaleById,
  listSales,
  serializeSale,
} from '../../services/saleService.js';
import { getBrandByCodeOrId } from '../../services/brandService.js';
import { reconcileSale } from '../../services/reconciliationService.js';

export const salesRouter = Router();

const createSaleSchema = z.object({
  userId: z.string().min(1), // handle or id
  brand: z.string().min(1), // code or id
  earning: z.number().positive(),
});

salesRouter.post(
  '/',
  validate(createSaleSchema),
  asyncHandler(async (req, res) => {
    const sale = await createSale(req.body);
    const brand = await getBrandByCodeOrId(sale.brandId);
    res.status(201).json({ sale: serializeSale(sale, brand) });
  }),
);

salesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const sales = await listSales({ userId: req.query.userId });
    const withBrand = await Promise.all(
      sales.map(async (s) => serializeSale(s, await getBrandByCodeOrId(s.brandId))),
    );
    res.json({ sales: withBrand });
  }),
);

salesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const sale = await getSaleById(req.params.id);
    const brand = await getBrandByCodeOrId(sale.brandId);
    res.json({ sale: serializeSale(sale, brand) });
  }),
);

const reconcileSchema = z.object({
  status: z.enum(['approved', 'rejected']),
});

salesRouter.post(
  '/:id/reconcile',
  validate(reconcileSchema),
  asyncHandler(async (req, res) => {
    const result = await reconcileSale({ saleId: req.params.id, status: req.body.status });
    res.json(result);
  }),
);
