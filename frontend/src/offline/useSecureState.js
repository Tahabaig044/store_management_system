import { useEffect, useState } from 'react';
import { secureState, subscribeSecure } from './secureStore';

// 'unavailable' | 'locked' | 'unlocked' for this user's protected offline data, live.
export function useSecureState(tenantId) {
  const [state, setState] = useState(() => (tenantId ? secureState(tenantId) : 'unlocked'));
  useEffect(() => {
    if (!tenantId) return undefined;
    const update = () => setState(secureState(tenantId));
    update();
    return subscribeSecure(update);
  }, [tenantId]);
  return state;
}
