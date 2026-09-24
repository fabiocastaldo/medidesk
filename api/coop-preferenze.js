// api/coop-preferenze.js
// Preferenze dell'organizzazione. Per ora: booking_pubblico — se attivo,
// l'agenda del medico sui sede-centri è prenotabile anche dal link pubblico
// del medico, senza passare dalla segreteria. La fonte di verità è
// cooperative.booking_pubblico; il valore viene specchiato su tutti i
// centri della cooperativa (coop_booking_pubblico) così la SPA del medico
// lo legge dai dati che già carica, a RLS invariata.

import { richiediAal2Secco } from '../lib/aal-guard.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Autenticazione richiesta' });
  }
  const jwt = authHeader.slice(7);

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey     = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return res.status(500).json({ error: 'Configurazione server mancante' });
  }
  const b = req.body || {};
  const AZIONI = {
    set_booking_pubblico: 'booking_pubblico',
    set_mail_conferma_paziente: 'mail_conferma_paziente',
    set_mail_notifica_medico: 'mail_notifica_medico',
    set_mail_ricevuta_segreteria: 'mail_ricevuta_segreteria',
    // Verifica in due passaggi obbligatoria per tutte le segreterie dell'organizzazione
    // (admin compreso). Solo l'admin la cambia; oggi il flag si legge e si mostra, l'obbligo
    // al primo accesso e la pretesa di aal2 sui coop-* arrivano col ciclo 2 di T-15.
    set_mfa_obbligatoria: 'mfa_obbligatoria'
  };
  const colonna = AZIONI[b.action];
  if (!colonna || typeof b.valore !== 'boolean') {
    return res.status(400).json({ error: 'Parametri non validi' });
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': anonKey }
  }).catch(() => null);
  if (!userRes || !userRes.ok) {
    return res.status(401).json({ error: 'Token non valido o scaduto' });
  }
  const userData = await userRes.json().catch(() => null);
  if (!userData?.id) {
    return res.status(401).json({ error: 'Utente non riconosciuto' });
  }

  const srvHeaders = { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` };
  const segRes = await fetch(
    `${supabaseUrl}/rest/v1/segreterie?user_id=eq.${encodeURIComponent(userData.id)}&select=id,stato,ruolo,cooperativa_id,cooperative(mfa_obbligatoria,id,stato)`,
    { headers: srvHeaders }
  ).catch(() => null);
  const seg = (segRes && segRes.ok) ? (await segRes.json().catch(() => []))?.[0] : null;
  if (!seg || seg.stato !== 'attiva' || !seg.cooperative || seg.cooperative.stato !== 'attiva') {
    return res.status(403).json({ error: 'Account non abilitato' });
  }
  // T-15 ciclo 2: se l'amministratore ha reso obbligatoria la verifica in due passaggi,
  // ogni chiamata della segreteria deve portare un token al secondo livello.
  if (seg.cooperative.mfa_obbligatoria === true) {
    const aalKo = richiediAal2Secco(jwt);
    if (aalKo) return res.status(aalKo.status).json({ error: aalKo.error, code: aalKo.code });
  }
  if (seg.ruolo !== 'admin') {
    return res.status(403).json({ error: 'Operazione riservata all\'amministratore' });
  }

  const upCoop = await fetch(
    `${supabaseUrl}/rest/v1/cooperative?id=eq.${encodeURIComponent(seg.cooperativa_id)}`,
    { method: 'PATCH', headers: { ...srvHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ [colonna]: b.valore }) }
  ).catch(() => null);
  const coopRow = (upCoop && upCoop.ok) ? (await upCoop.json().catch(() => []))?.[0] : null;
  if (!coopRow) {
    return res.status(500).json({ error: 'Aggiornamento non riuscito' });
  }
  // specchio su tutti i centri della cooperativa (solo per il booking pubblico:
  // la SPA del medico lo legge dai centri; i flag email vivono solo qui)
  if (colonna === 'booking_pubblico') await fetch(
    `${supabaseUrl}/rest/v1/centri?cooperativa_id=eq.${encodeURIComponent(seg.cooperativa_id)}`,
    { method: 'PATCH', headers: { ...srvHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coop_booking_pubblico: b.valore }) }
  ).catch(() => null);

  if (colonna === 'mfa_obbligatoria') {
    console.log('[coop-preferenze] mfa_obbligatoria', b.valore, 'cooperativa', seg.cooperativa_id, 'da', userData.id);
    // Audit della plancia (T-15 ciclo 2): riga in audit_log senza medico, con segreteria e
    // organizzazione nei dettagli. Soft-fail: la preferenza e' gia scritta.
    await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
      method: 'POST',
      headers: { ...srvHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        medico_id: null, action: 'mfa_obbligatoria_cambiata', target_type: 'cooperativa', target_id: String(seg.cooperativa_id),
        details: { valore: coopRow[colonna] === true, segreteria_id: seg.id, user_id: userData.id, auth_mode: 'jwt_segreteria' }
      })
    }).then(r => { if (!r.ok) console.error('[coop-preferenze] audit non scritto', r.status); })
      .catch(e => console.error('[coop-preferenze] audit:', e.message));
  }

  return res.status(200).json({ [colonna]: coopRow[colonna] });
}
