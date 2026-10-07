// The feature flag, and the one piece of state every WhatsApp surface needs:
// which patients have turned messages off.
//
// A clinic that has not been switched on gets `enabled: false` and makes no
// /whatsapp/* request for the lifetime of the session. That is what lets this
// bundle ship to every clinic at once while the feature is turned on one at a
// time: the new code is present but never reaches the network, so a clinic
// still waiting on its rollout runs exactly as it did before.

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { fetchWaConfig, waConfigured } from './waApi';

const WaContext = createContext({
  enabled: false, clinicPhone: '', optedOut: new Set(), isOptedOut: () => false, ready: false,
});

export function WaProvider({ org, orgLoaded, children }) {
  const [cfg, setCfg] = useState(null);
  const [ready, setReady] = useState(false);

  // `org.waEnabled` gates the config call itself. Reading the flag from the
  // org record — which the app already fetches at boot — means a clinic
  // without WhatsApp pays nothing: no extra request, no failed request, no
  // error in the console for staff to report.
  const orgSaysOn = !!(org && org.waEnabled);

  // `ready` must mean "we know whether this clinic has WhatsApp", not "we
  // have finished trying". Flipping it before the org record lands would let
  // the Appointments tab paint the old list and then swap it for the
  // calendar a moment later, which reads as a bug to anyone watching.
  useEffect(() => {
    let cancelled = false;
    if (!orgLoaded) return undefined;
    if (!orgSaysOn || !waConfigured()) { setReady(true); return undefined; }
    fetchWaConfig()
      .then((c) => { if (!cancelled) setCfg(c); })
      // A failure here must degrade to "off", not to a broken console. The
      // staff's actual job is seeing patients; losing the Messages tab for a
      // session is survivable, losing the Visits tab is not.
      .catch(() => { if (!cancelled) setCfg(null); })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [orgSaysOn, orgLoaded]);

  const value = useMemo(() => {
    const optedOut = (cfg && cfg.optedOut) || new Set();
    return {
      enabled: !!(cfg && cfg.enabled),
      clinicPhone: (cfg && cfg.clinicPhone) || '',
      optedOut,
      isOptedOut: (mobile) => optedOut.has(String(mobile || '').replace(/\D/g, '').slice(-10)),
      ready,
    };
  }, [cfg, ready]);

  return <WaContext.Provider value={value}>{children}</WaContext.Provider>;
}

export function useWa() {
  return useContext(WaContext);
}
