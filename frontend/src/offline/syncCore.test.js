import { describe, it, expect } from 'vitest';
import { classifyFailure, backoffMs, MAX_SERVER_ATTEMPTS, extractRefs, resolveRefs, refTo, describeFailure } from './syncCore';

const http = (status, code, error = 'x') => ({ response: { status, data: { code, error } } });

describe('classifyFailure - one rejection, one deterministic outcome', () => {
  it('no response at all is a network problem: wait, uncounted', () => {
    expect(classifyFailure(new Error('Network Error')).action).toBe('network');
    expect(classifyFailure({ code: 'ECONNABORTED', message: 'timeout' }).action).toBe('network');
  });

  it('401 pauses the queue; transient server errors retry with backoff', () => {
    expect(classifyFailure(http(401)).action).toBe('auth');
    for (const s of [500, 502, 503, 504, 408, 425, 429]) expect(classifyFailure(http(s)).action).toBe('server');
  });

  it('every server-state conflict is a visible conflict, keyed by its machine code and never by message text', () => {
    for (const code of ['STOCK_INSUFFICIENT', 'DOCUMENT_NOT_OPEN', 'PERIOD_CLOSED', 'BALANCE_CHANGED', 'DUPLICATE', 'CONFLICT']) {
      const c = classifyFailure(http(409, code, 'whatever wording'));
      expect(c).toMatchObject({ action: 'conflict', kind: code, status: 409, code });
    }
    expect(classifyFailure(http(409, undefined)).kind).toBe('CONFLICT');
    // A stale balance / stock reported as 422 is still a conflict, not a permanent rejection.
    expect(classifyFailure(http(422, 'BALANCE_CHANGED')).action).toBe('conflict');
    expect(classifyFailure(http(422, 'STOCK_INSUFFICIENT')).action).toBe('conflict');
    expect(classifyFailure(http(404, 'NOT_FOUND')).action).toBe('conflict');
  });

  it('validation and permission problems are permanent failures, not conflicts', () => {
    expect(classifyFailure(http(422, 'VALIDATION')).action).toBe('failed');
    expect(classifyFailure(http(400)).action).toBe('failed');
    expect(classifyFailure(http(403, 'FORBIDDEN'))).toMatchObject({ action: 'failed', kind: 'FORBIDDEN' });
  });

  it('"already applied" is success ONLY for an action whose intent is idempotent (a reversal)', () => {
    expect(classifyFailure(http(409, 'ALREADY_APPLIED'), { intentIdempotent: true }).action).toBe('success');
    expect(classifyFailure(http(409, 'ALREADY_APPLIED'), { intentIdempotent: false }).action).toBe('conflict');
  });

  it('is the same answer every time', () => {
    const err = http(409, 'STOCK_INSUFFICIENT', 'Insufficient stock for X (available: 4)');
    const a = classifyFailure(err);
    const b = classifyFailure(err);
    expect({ ...a, at: 0 }).toEqual({ ...b, at: 0 });
  });
});

describe('backoff', () => {
  it('grows exponentially, is capped, and is jittered within +/-20%', () => {
    const mid = () => 0.5; // jitter factor 1.0
    expect(backoffMs(1, mid)).toBe(5000);
    expect(backoffMs(2, mid)).toBe(10000);
    expect(backoffMs(3, mid)).toBe(20000);
    expect(backoffMs(20, mid)).toBe(300000);
    expect(backoffMs(3, () => 0)).toBe(16000);
    expect(backoffMs(3, () => 1)).toBe(24000);
  });

  it('is bounded: a fixed number of transient attempts, then a person is asked', () => {
    expect(MAX_SERVER_ATTEMPTS).toBeGreaterThanOrEqual(5);
    expect(MAX_SERVER_ATTEMPTS).toBeLessThanOrEqual(12);
  });
});

describe('dependency references', () => {
  it('finds references anywhere in a payload and resolves them to real ids without touching the original', () => {
    const payload = { customerId: refTo('c-1'), items: [{ productId: 'p1' }], allocations: [{ saleId: refTo('s-1'), amount: 5 }], note: 'plain' };
    expect([...extractRefs(payload)].sort()).toEqual(['c-1', 's-1']);
    const resolved = resolveRefs(payload, (id) => ({ 'c-1': 'server-c', 's-1': 'server-s' })[id]);
    expect(resolved).toEqual({ customerId: 'server-c', items: [{ productId: 'p1' }], allocations: [{ saleId: 'server-s', amount: 5 }], note: 'plain' });
    expect(payload.customerId).toBe('$ref:c-1');
  });

  it('a payload without references has none', () => {
    expect([...extractRefs({ a: 1, b: ['x', { c: 'y' }] })]).toHaveLength(0);
  });
});

describe('describeFailure', () => {
  it('gives every conflict a plain title, the server\'s detail and an action, and says whether retrying can help', () => {
    const stock = describeFailure({ kind: 'STOCK_INSUFFICIENT', message: 'Insufficient stock for X (available: 4)' });
    expect(stock).toMatchObject({ title: 'Not enough stock on the server', detail: 'Insufficient stock for X (available: 4)', retryable: true });
    expect(stock.advice).toMatch(/retry|discard/i);
    expect(describeFailure({ kind: 'ALREADY_APPLIED', message: 'x' }).retryable).toBe(false);
    expect(describeFailure({ kind: 'PERIOD_CLOSED', message: 'x' }).title).toMatch(/period/i);
    expect(describeFailure(null)).toBeNull();
  });
});
