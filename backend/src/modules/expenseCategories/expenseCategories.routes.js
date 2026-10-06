const express = require('express');
const { z } = require('zod');
const buildCrudController = require('../../utils/crudFactory');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { FINANCE_STAFF } = require('../../constants/roles');

const createSchema = z.object({ name: z.string().min(1) });
const updateSchema = z.object({ name: z.string().min(1).optional(), isActive: z.boolean().optional() });

const controller = buildCrudController({ model: 'expenseCategory', createSchema, updateSchema });

const router = express.Router();
router.use(authenticate, requireTenant, requireRole(...FINANCE_STAFF));

router.get('/', controller.list);
router.get('/:id', controller.getOne);
router.post('/', controller.create);
router.patch('/:id', controller.update);
router.delete('/:id', controller.archive);

module.exports = router;
