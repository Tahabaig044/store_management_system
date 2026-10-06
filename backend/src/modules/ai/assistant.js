// The AI Business Assistant: ties together intent matching, deterministic
// fact retrieval, the provider abstraction, conversation persistence, and
// usage tracking. This is the one function the /ai/ask route calls.
const prisma = require('../../config/prisma');
const { matchIntent, buildFacts, SUGGESTED_QUESTIONS } = require('./context');
const { callProvider } = require('./providers/provider');
const { getConfig, assertWithinQuota, logUsage } = require('./usage');
const { NotFoundError } = require('../../utils/errors');
const { decryptCredentials } = require('../../utils/credentialCrypto');

async function ask({ tenantId, userId, branchId, question, conversationId }) {
  const config = await assertWithinQuota(tenantId);

  let conversation;
  if (conversationId) {
    conversation = await prisma.aiConversation.findFirst({ where: { id: conversationId, tenantId, userId } });
    if (!conversation) throw new NotFoundError('Conversation not found');
  } else {
    conversation = await prisma.aiConversation.create({ data: { tenantId, userId, title: question.slice(0, 80) } });
  }

  await prisma.aiMessage.create({ data: { conversationId: conversation.id, role: 'USER', content: question } });

  const intent = matchIntent(question);
  const facts = await buildFacts(intent, { tenantId, branchId });
  // Phase 7.1: credentials are stored encrypted (see config.routes.js) and are
  // only ever decrypted here, in-process, immediately before being handed to
  // the provider that actually needs them - never logged, never returned to
  // any API response.
  const result = await callProvider(config.provider, { intent, facts, question, credentials: decryptCredentials(config.credentials) });

  const assistantMessage = await prisma.aiMessage.create({
    data: { conversationId: conversation.id, role: 'ASSISTANT', content: result.text, grounding: facts, intent, confidence: result.confidence },
  });

  await logUsage({ tenantId, userId, feature: 'assistant_ask', provider: result.provider });

  return {
    conversationId: conversation.id,
    message: assistantMessage,
    intent,
    isRecognized: intent !== 'unrecognized',
    fellBack: result.fellBack,
    // Phase 6.3: an explicit, always-present signal for the frontend to show a clear
    // "AI not configured" / "using basic analysis" state rather than silently presenting
    // a deterministic, template-phrased answer as if it came from a real LLM.
    // - 'llm': a real provider (e.g. anthropic) is configured and answered this message.
    // - 'fallback': a real provider IS configured but was unreachable/failed just now -
    //   this message used the deterministic provider instead.
    // - 'deterministic': no real provider has been configured for this tenant at all;
    //   deterministic BI answers remain fully available, as required.
    aiMode: result.provider !== 'deterministic' ? 'llm' : config.provider !== 'deterministic' ? 'fallback' : 'deterministic',
    suggestedQuestions: intent === 'unrecognized' ? SUGGESTED_QUESTIONS : undefined,
  };
}

async function listConversations(tenantId, userId) {
  return prisma.aiConversation.findMany({ where: { tenantId, userId }, orderBy: { updatedAt: 'desc' }, take: 50 });
}

async function getConversation(tenantId, userId, conversationId) {
  const conversation = await prisma.aiConversation.findFirst({
    where: { id: conversationId, tenantId, userId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!conversation) throw new NotFoundError('Conversation not found');
  return conversation;
}

module.exports = { ask, listConversations, getConversation, getConfig };
