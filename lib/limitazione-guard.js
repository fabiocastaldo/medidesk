// lib/limitazione-guard.js
// Riga 78 del piano privacy (s68, 03/10/2026): limitazione del trattamento ex art. 18 GDPR.
// La regola vive nel database: pazienti.limitato_at (impostata e revocata solo dalla RPC limita_paziente,
// con traccia in audit_log) e i trigger trg_limitazione sulle sei tabelle del paziente, che fermano le
// scritture del gestionale (ruolo authenticated). Il server scrive e invia con la chiave di servizio,
// che i trigger non toccano: gli endpoint che agiscono per un paziente lo verificano qui.
//   - paziente non limitato (o nessun paziente di fascicolo) → { ok: true }
//   - paziente limitato → 422 LIMITAZIONE_ART18 (consultare ed esportare restano possibili)
//   - verifica non riuscita → 503 (fail-closed: senza verifica non si invia)
// Unica eccezione, come nella sola consultazione (A2): l'annullamento di un appuntamento futuro
// eseguito dal server, con l'email al paziente e la traccia in audit_log (ramo cancellazione_paziente di send-email).

export const RISPOSTA_LIMITAZIONE = {
  error: 'Il trattamento dei dati di questo paziente è limitato (art. 18 GDPR): puoi consultare ed esportare, non inviare comunicazioni.',
  code: 'LIMITAZIONE_ART18'
};

export async function pazienteLimitato(pazienteId, { supabaseUrl, serviceKey }) {
  const ko503 = { ok: false, status: 503, body: { error: 'Verifica della limitazione non disponibile, riprova tra poco.', code: 'VERIFICA_LIMITAZIONE' } };
  if (!pazienteId) return { ok: true, limitato: false };
  if (!supabaseUrl || !serviceKey) return ko503;
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/pazienti?id=eq.${encodeURIComponent(pazienteId)}&select=id,limitato_at`, {
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
    });
    if (!r.ok) return ko503;
    const rows = await r.json();
    const p = Array.isArray(rows) ? rows[0] : null;
    if (!p) return { ok: true, limitato: false };
    if (p.limitato_at) return { ok: false, status: 422, body: RISPOSTA_LIMITAZIONE, limitato: true, limitato_at: p.limitato_at };
    return { ok: true, limitato: false };
  } catch (_) {
    return ko503;
  }
}

// Per i job e gli invii di massa: insieme degli id dei pazienti limitati (null se la lettura fallisce).
export async function idPazientiLimitati({ supabaseUrl, serviceKey }) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/pazienti?limitato_at=not.is.null&select=id,email`, {
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return { ids: new Set(rows.map(p => p.id)), email: new Set(rows.map(p => String(p.email || '').trim().toLowerCase()).filter(Boolean)) };
  } catch (_) {
    return null;
  }
}
