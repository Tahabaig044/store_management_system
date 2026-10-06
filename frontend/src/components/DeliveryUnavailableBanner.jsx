import { useEffect, useState } from 'react';
import apiClient from '../api/client';

// WhatsApp automation only *delivers* when a real messaging provider is connected. On an installation
// without one, messages are recorded as FAILED (never "sent"), and this says so up front.
export default function DeliveryUnavailableBanner() {
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    apiClient
      .get('/auth/config')
      .then((res) => setUnavailable(res.data.whatsappAvailable === false))
      .catch(() => {});
  }, []);

  if (!unavailable) return null;
  return (
    <div className="alert alert-warning" data-testid="delivery-unavailable">
      <strong>WhatsApp messaging is not connected on this system.</strong> Messages and automations are recorded
      but are <em>not delivered</em> to customers until a messaging provider is set up.
    </div>
  );
}
