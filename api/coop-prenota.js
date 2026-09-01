// api/coop-prenota.js
// Tappa 3 prenotazioni per-terzi: la segreteria della cooperativa prenota
// per conto del paziente su uno slot dei sede-centri coop del medico.
// Rivalidazione SERVER-SIDE completa (il client propone, il server dispone):
// perimetro cooperativa, copertura dello slot via lib/slot-guard.js (turno attivo
// con griglia OPPURE giornata singola), guardia ferie BLOCCANTE, concorrenza
// arbitrata dal DB via appuntamenti_slot_unique: 23505 -> 409 slot_taken.
// Dati minimi per-terzi: nome/cognome/telefono + dichiarazione di consenso
// raccolto dal paziente (consenso_versione 'cons-coop-tel-1' marca il canale).

import { randomUUID } from 'node:crypto';
import { verificaSlot } from '../lib/slot-guard.js';

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

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
  const medicoId = clean(b.medico_id, 64);
  const centroId = clean(b.centro_id, 64);
  const data     = clean(b.data, 10);
  const ora      = clean(b.ora, 5);
  const nome     = clean(b.nome, 80);
  const cognome  = clean(b.cognome, 80);
  const telefono = clean(b.telefono, 40);
  const tipo     = clean(b.tipo_visita, 120);
  const area     = clean(b.area, 120);
  const email    = clean(b.email, 160);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email non valida' });
  }
  if (!medicoId || !centroId) return res.status(400).json({ error: 'Parametri non validi' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ error: 'Data non valida' });
  if (!/^\d{2}:\d{2}$/.test(ora)) return res.status(400).json({ error: 'Ora non valida' });
  if (!nome || !cognome) return res.status(400).json({ error: 'Nome e cognome del paziente obbligatori' });
  if (!telefono) return res.status(400).json({ error: 'Telefono del paziente obbligatorio' });
  if (b.consenso !== true) return res.status(400).json({ error: 'Dichiarazione di consenso obbligatoria' });
  if (data < new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: 'La data è nel passato' });
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
    `${supabaseUrl}/rest/v1/segreterie?user_id=eq.${encodeURIComponent(userData.id)}&select=id,stato,cooperativa_id,cooperative(id,stato,mail_conferma_paziente,mail_notifica_medico,mail_ricevuta_segreteria)`,
    { headers: srvHeaders }
  ).catch(() => null);
  const seg = (segRes && segRes.ok) ? (await segRes.json().catch(() => []))?.[0] : null;
  if (!seg || seg.stato !== 'attiva' || !seg.cooperative || seg.cooperative.stato !== 'attiva') {
    return res.status(403).json({ error: 'Account non abilitato' });
  }

  // Perimetro: il centro deve appartenere alla cooperativa del chiamante ED essere del medico indicato
  const centroRes = await fetch(
    `${supabaseUrl}/rest/v1/centri?id=eq.${encodeURIComponent(centroId)}&cooperativa_id=eq.${encodeURIComponent(seg.cooperativa_id)}&medico_id=eq.${encodeURIComponent(medicoId)}&select=id`,
    { headers: srvHeaders }
  ).catch(() => null);
  const centro = (centroRes && centroRes.ok) ? (await centroRes.json().catch(() => []))?.[0] : null;
  if (!centro) {
    return res.status(404).json({ error: 'Centro non collegato all\'organizzazione' });
  }

  // Gate di copertura: stesso arbitro del booking pubblico (lib/slot-guard.js):
  // turno attivo (giorno, dal/al, frequenza, griglia) OPPURE giornata singola
  // (disponibilita_singole) sulla data; ferie del medico bloccanti. 422 / 502.
  const sb = (path) => fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: srvHeaders });
  const v = await verificaSlot({ sb, medicoId, centroId, data, ora });
  if (!v.ok) {
    return res.status(v.status).json({ error: v.error });
  }

  // INSERT: la concorrenza la arbitra il DB (appuntamenti_slot_unique) -> un vincitore, 409 agli altri
  const consentTs = new Date().toISOString();
  const cancellationToken = randomUUID().replace(/-/g, '');
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/appuntamenti?select=id`, {
      method: 'POST',
      headers: { ...srvHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({
        medico_id: medicoId,
        centro_id: centroId,
        data, ora,
        nome_paziente: nome,
        cognome_paziente: cognome,
        telefono_paziente: telefono,
        email_paziente: email || null,
        tipo_visita: tipo || null,
        area_tematica: area || null,
        source: 'paziente',
        segreteria_id: seg.id,
        cancellation_token: cancellationToken,
        consenso_base_at: consentTs,
        consenso_health_at: consentTs,
        consenso_versione: 'cons-coop-tel-1',
        per_conto: true,
        da_centro: true
      })
    });
    if (r.status === 409) return res.status(409).json({ error: 'slot_taken' });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      if (body.includes('appuntamenti_slot_unique') || body.includes('23505')) {
        return res.status(409).json({ error: 'slot_taken' });
      }
      return res.status(500).json({ error: 'Creazione prenotazione fallita' });
    }
    const arr = await r.json().catch(() => []);
    const apptId = arr?.[0]?.id;
    if (!apptId) return res.status(500).json({ error: 'Creazione prenotazione fallita' });
    // Email best-effort, MAI bloccanti (l'appuntamento e' gia' salvato):
    // conferma al paziente via token email (path anonimo, senza doppia notifica
    // interna), notifica al medico via token di cancellazione. I toggle di
    // cooperativa arriveranno con le colonne dedicate (DDL su mandato);
    // fino ad allora il canale e' attivo di default.
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const mailPaz = seg.cooperative.mail_conferma_paziente !== false;
    const mailMed = seg.cooperative.mail_notifica_medico !== false;
    if (host && email && mailPaz) {
      try {
        const tr = await fetch(`${supabaseUrl}/rest/v1/rpc/emit_email_token_for_appt`, {
          method: 'POST',
          headers: { ...srvHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_appt_id: apptId })
        });
        if (tr.ok) {
          const tok = await tr.json().catch(() => null);
          const jti = Array.isArray(tok) ? tok[0]?.jti : tok?.jti;
          if (jti) {
            await fetch(`https://${host}/api/send-email`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tipo: 'conferma_appt_anon', email_token: jti, skip_notifica_centro: true })
            }).catch(() => {});
          }
        }
      } catch { /* soft-fail */ }
    }
    if (host && mailMed) {
      try {
        await fetch(`https://${host}/api/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tipo: 'notifica_prenotazione_coop', appt_id: apptId, cancellation_token: cancellationToken })
        }).catch(() => {});
      } catch { /* soft-fail */ }
    }
    // ricevuta alla segreteria (disattivabile dalle Preferenze)
    if (host && seg.cooperative.mail_ricevuta_segreteria !== false) {
      try {
        const rSeg = await fetch(`https://${host}/api/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tipo: 'conferma_prenotazione_segreteria', appt_id: apptId, cancellation_token: cancellationToken })
        }).catch(() => null);
        console.log('[coop-prenota] ricevuta segreteria:', rSeg ? rSeg.status : 'no-response');
      } catch { /* soft-fail */ }
    }
    return res.status(200).json({ ok: true, appt_id: apptId, data, ora, email_inviata: !!email && mailPaz });
  } catch {
    return res.status(500).json({ error: 'Creazione prenotazione fallita' });
  }
}
