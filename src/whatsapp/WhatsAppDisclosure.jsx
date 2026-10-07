// Under the mobile-number field at registration.
//
// This is the clinic telling the patient what the number will be used for,
// at the moment it is collected. It is static text and never a checkbox:
// these are utility messages about care the patient has already asked for,
// and STOP is always one word away.

import { WaGlyph } from './ui';
import { useWa } from './WaContext';

export default function WhatsAppDisclosure() {
  const wa = useWa();
  if (!wa.enabled) return null;
  return (
    <p style={{
      display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10,
      fontSize: 12.5, color: '#5c7a76', lineHeight: 1.5,
    }}>
      <span style={{ marginTop: 2 }}><WaGlyph size={13} color="#8aa8a3" /></span>
      We'll send appointment reminders, prescriptions and receipts to this number on WhatsApp.
      Patients can reply STOP at any time.
    </p>
  );
}
