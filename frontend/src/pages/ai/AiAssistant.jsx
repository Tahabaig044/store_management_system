import { useEffect, useRef, useState } from 'react';
import apiClient from '../../api/client';
import { Spinner, ErrorAlert, extractErrorMessage } from '../../components/Feedback';

function ConfidenceBadge({ confidence }) {
  if (confidence === null || confidence === undefined) return null;
  const pct = Math.round(confidence * 100);
  const tone = pct >= 80 ? 'success' : pct >= 50 ? 'warning' : 'secondary';
  return <span className={`badge text-bg-${tone} ms-2`}>Confidence: {pct}%</span>;
}

// Phase 6.3: makes it explicit whether this answer came from a real configured AI
// provider, or from the always-available deterministic analysis - never silently
// presents one as the other.
function AiModeBadge({ aiMode }) {
  if (aiMode === 'llm') return <span className="badge text-bg-primary ms-2">AI-generated</span>;
  if (aiMode === 'fallback') return <span className="badge text-bg-warning ms-2" title="Your configured AI provider was unavailable - this used basic analysis instead.">Basic analysis (AI unavailable)</span>;
  if (aiMode === 'deterministic') return <span className="badge text-bg-secondary ms-2" title="No external AI provider is configured for this account. Answers are grounded, deterministic business analysis.">Basic analysis (AI not configured)</span>;
  return null;
}

export default function AiAssistant() {
  const [suggested, setSuggested] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    apiClient.get('/ai/assistant/suggested-questions').then((res) => setSuggested(res.data.items || []));
    apiClient.get('/ai/assistant/conversations').then((res) => setConversations(res.data.items || [])).catch(() => {});
  }, []);

  useEffect(() => {
    // jsdom (used in tests) doesn't implement scrollIntoView - guard so the
    // component still works under test, not just in a real browser.
    if (typeof bottomRef.current?.scrollIntoView === 'function') {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  async function openConversation(id) {
    setError('');
    const res = await apiClient.get(`/ai/assistant/conversations/${id}`);
    setConversationId(id);
    setMessages(res.data.item.messages);
  }

  function newConversation() {
    setConversationId(null);
    setMessages([]);
  }

  async function ask(text) {
    const q = (text ?? question).trim();
    if (!q) return;
    setSending(true);
    setError('');
    setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: 'USER', content: q }]);
    setQuestion('');
    try {
      const res = await apiClient.post('/ai/assistant/ask', { question: q, conversationId: conversationId || undefined });
      setConversationId(res.data.conversationId);
      setMessages((prev) => [...prev, { ...res.data.message, aiMode: res.data.aiMode }]);
      if (!conversationId) {
        apiClient.get('/ai/assistant/conversations').then((r) => setConversations(r.data.items || []));
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="d-flex gap-3" style={{ height: 'calc(100vh - 140px)' }}>
      <div className="d-none d-lg-flex flex-column border-end pe-3" style={{ width: 240 }}>
        <button className="btn btn-sm btn-primary mb-2" onClick={newConversation}>+ New Conversation</button>
        <div className="overflow-auto flex-grow-1">
          {conversations.map((c) => (
            <button
              key={c.id}
              className={`btn btn-sm text-start w-100 mb-1 ${c.id === conversationId ? 'btn-secondary' : 'btn-outline-secondary'}`}
              onClick={() => openConversation(c.id)}
            >
              {c.title || 'Conversation'}
            </button>
          ))}
        </div>
      </div>

      <div className="d-flex flex-column flex-grow-1">
        <div className="d-flex justify-content-between align-items-center mb-2">
          <h4 className="mb-0">AI Business Assistant</h4>
        </div>
        <p className="text-body-secondary small">
          Ask about sales, profit, inventory, receivables/payables, or optical/clinic operations. Answers are grounded
          in your own business data - predictions and recommendations are always labeled as such.
        </p>

        <ErrorAlert message={error} />

        <div className="flex-grow-1 overflow-auto border rounded p-3 mb-3 bg-body-secondary bg-opacity-25">
          {messages.length === 0 && (
            <div className="d-flex flex-wrap gap-2">
              {suggested.map((s) => (
                <button key={s} className="btn btn-sm btn-outline-primary" onClick={() => ask(s)}>{s}</button>
              ))}
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`d-flex mb-3 ${m.role === 'USER' ? 'justify-content-end' : 'justify-content-start'}`}>
              <div className={`p-2 px-3 rounded-3 ${m.role === 'USER' ? 'bg-primary text-white' : 'bg-body border'}`} style={{ maxWidth: '75%' }}>
                <div>{m.content}</div>
                {m.role === 'ASSISTANT' && (
                  <>
                    <ConfidenceBadge confidence={m.confidence} />
                    <AiModeBadge aiMode={m.aiMode} />
                    {m.grounding && (
                      <details className="mt-2 small">
                        <summary className="text-body-secondary" style={{ cursor: 'pointer' }}>Source data used</summary>
                        <pre className="small mb-0 mt-1" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(m.grounding, null, 2)}</pre>
                      </details>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
          {sending && <Spinner />}
          <div ref={bottomRef} />
        </div>

        <form
          className="d-flex gap-2"
          onSubmit={(e) => { e.preventDefault(); ask(); }}
        >
          <input className="form-control" placeholder="Ask a business question..." value={question} onChange={(e) => setQuestion(e.target.value)} disabled={sending} />
          <button className="btn btn-primary" type="submit" disabled={sending || !question.trim()}>Send</button>
        </form>
      </div>
    </div>
  );
}
