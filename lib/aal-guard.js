// lib/aal-guard.js — livello di garanzia della sessione (T-15 ciclo 2).
// Il claim `aal` vive solo nel payload del JWT: GET /auth/v1/user non lo restituisce.
// Da chiamare SOLO dopo che /auth/v1/user ha validato firma e scadenza del token:
// qui il payload viene letto, non verificato.

export function aalDaJwt(jwt) {
  try {
    const seg = String(jwt || '').split('.')[1] || '';
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - seg.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return typeof payload.aal === 'string' ? payload.aal : null;
  } catch (_) {
    return null;
  }
}

// null se il token e' al secondo livello, altrimenti l'errore da restituire (403).
export function richiediAal2(jwt) {
  if (aalDaJwt(jwt) === 'aal2') return null;
  return { status: 403, error: 'Serve la verifica in due passaggi: esci e rientra inserendo il codice', code: 'AAL2_REQUIRED' };
}
