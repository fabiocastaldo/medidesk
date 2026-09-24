// lib/aal-guard.js — livello di garanzia della sessione (T-15 ciclo 2).
// Il claim `aal` vive solo nel payload del JWT: GET /auth/v1/user non lo restituisce, ma
// restituisce `factors`. Da chiamare SOLO dopo che /auth/v1/user ha validato il token:
// qui il payload viene letto, non verificato.
//
// Regola del medico (decisione di prodotto 24/09): chi ha un dispositivo registrato entra
// solo col codice (aal2); chi non ne ha ancora entra come prima e viene invitato ad attivarlo.
// L'obbligo secco si accende con MFA_OBBLIGATORIA_MEDICO=true (nessun dispositivo -> 403).
// Regola dell'organizzazione: aal2 preteso senza eccezioni se cooperative.mfa_obbligatoria.

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

export function fattoriVerificati(userData) {
  const f = userData && Array.isArray(userData.factors) ? userData.factors : [];
  return f.filter(x => x && x.status === 'verified').length;
}

const ERR = { status: 403, error: 'Serve la verifica in due passaggi: esci e rientra inserendo il codice', code: 'AAL2_REQUIRED' };
const ERR_ATTIVA = { status: 403, error: 'Attiva la verifica in due passaggi dalla pagina Sicurezza per continuare', code: 'MFA_DA_ATTIVARE' };

// Medico: null se puo' passare, altrimenti l'errore da restituire.
export function richiediAal2(jwt, userData) {
  if (aalDaJwt(jwt) === 'aal2') return null;
  if (fattoriVerificati(userData) > 0) return ERR;
  if (process.env.MFA_OBBLIGATORIA_MEDICO === 'true') return ERR_ATTIVA;
  return null;
}

// Organizzazione con regola accesa: aal2 senza eccezioni.
export function richiediAal2Secco(jwt) {
  return aalDaJwt(jwt) === 'aal2' ? null : ERR;
}
