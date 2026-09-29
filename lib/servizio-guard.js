// lib/servizio-guard.js
// Ciclo A2 (s64, 29/09/2026): sola consultazione durante uscita ed eliminazione.
// Regola unica, nel database: public.medico_puo_scrivere(uuid) (oggi = medico_in_servizio; il ciclo B aggiungerà
// lì le accettazioni mancanti). Gli endpoint che scrivono o chiamano l'AI per conto del medico la verificano qui,
// con la chiave di servizio, subito dopo richiediAal2 e la lettura del medico.
//   - in servizio            → { ok: true }
//   - fuori servizio         → 403 SOLA_CONSULTAZIONE (consultare ed esportare restano possibili)
//   - verifica non riuscita  → 503 (fail-closed: senza verifica non si scrive)
// Le scritture dirette del gestionale le ferma il trigger trg_sola_consultazione sulle 19 tabelle del medico.

export const RISPOSTA_SOLA_CONSULTAZIONE = {
  error: 'Account in sola consultazione: puoi consultare ed esportare i tuoi dati, ma non modificarli.',
  code: 'SOLA_CONSULTAZIONE'
};

export async function richiediInServizio(medicoId, { supabaseUrl, serviceKey }) {
  const ko503 = { ok: false, status: 503, body: { error: 'Verifica dello stato del servizio non disponibile, riprova tra poco.', code: 'VERIFICA_SERVIZIO' } };
  if (!medicoId || !supabaseUrl || !serviceKey) return ko503;
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/medico_puo_scrivere`, {
      method: 'POST',
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_medico_id: medicoId })
    });
    if (!r.ok) return ko503;
    const v = await r.json();
    if (v === true) return { ok: true };
    if (v === false) return { ok: false, status: 403, body: RISPOSTA_SOLA_CONSULTAZIONE };
    return ko503;
  } catch (_) {
    return ko503;
  }
}
