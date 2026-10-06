// The AI Business Assistant - owner/admin-facing only, per the phase's
// explicit scope ("Create an owner/admin-facing AI Business Assistant").
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { MANAGEMENT } = require('../../constants/roles');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const assistant = require('./assistant');
const { SUGGESTED_QUESTIONS } = require('./context');

const router = express.Router();
router.use(authenticate, requireTenant, requireRole(...MANAGEMENT));

router.get('/suggested-questions', (req, res) => {
  res.json({ items: SUGGESTED_QUESTIONS });
});

const askSchema = z.object({
  question: z.string().min(2).max(500),
  conversationId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
});

router.post('/ask', async (req, res) => {
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid question', parsed.error.flatten());

  if (parsed.data.branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: parsed.data.branchId, tenantId: req.user.tenantId } });
    if (!branch) throw new NotFoundError('Branch not found');
  }

  const result = await assistant.ask({
    tenantId: req.user.tenantId,
    userId: req.user.id,
    branchId: parsed.data.branchId,
    question: parsed.data.question,
    conversationId: parsed.data.conversationId,
  });

  await logAudit({ req, action: 'AI_ASSISTANT_ASK', entity: 'AiConversation', entityId: result.conversationId, metadata: { intent: result.intent } });
  res.status(201).json(result);
});

router.get('/conversations', async (req, res) => {
  const items = await assistant.listConversations(req.user.tenantId, req.user.id);
  res.json({ items });
});

router.get('/conversations/:id', async (req, res) => {
  const item = await assistant.getConversation(req.user.tenantId, req.user.id, req.params.id);
  res.json({ item });
});

module.exports = router;
