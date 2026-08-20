// api/coop-prenota.js
// Tappa 3 prenotazioni per-terzi: la segreteria della cooperativa prenota
// per conto del paziente su uno slot dei sede-centri coop del medico.
// Rivalidazione SERVER-SIDE completa (il client propone, il server dispone):
// perimetro cooperativa, turno attivo che copre lo slot (griglia inclusa),
// guardia ferie BLOCCANTE (in coop-agenda era informativa), concorrenza
// arbitrata dal DB via appuntamenti_slot_unique: 23505 -> 409 slot_taken.
// Dati minimi per-terzi: nome/cognome/telefono + dichiarazione di consenso
// raccolto dal paziente (consenso_versione 'cons-coop-tel-1' marca il canale).

import { randomUUID } from 'node:crypto';

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const t2m = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

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
    `${supabaseUrl}/rest/v1/segreterie?user_id=eq.${encodeURIComponent(userData.id)}&select=stato,cooperativa_id,cooperative(id,stato,mail_conferma_paziente,mail_notifica_medico,mail_ricevuta_segreteria)`,
    { headers: srvHeaders }
  ).catch(() => null);
  const seg = (segRes && segRes.ok) ? (await segRes.json().catch(() => []))?.[0] : null;
  if (!seg || seg.stato !== 'attiva' || !seg.cooperative || seg.cooperative.stato !== 'attiva') {
    return res.status(403).json({ error: 'Account non abilitato' });
  }

  // Perimetro: il centro deve appartenere alla cooperativa del chiamante ED essere del medico indicato
  const centroRes = await fetch(
    `${supabaseUrl}/rest/v1/centri?id=eq.${encodeURIComponent(centroId)}&cooperativa_id=eq.${encodeURIComponent(seg.cooperativa_id)}&medico_id=eq.${encodeURIComponent(medicoId)}&select=id,turni(giorno,inizio,fine,durata_slot,frequenza_settimane,data_inizio_validita,data_fine_validita)`,
    { headers: srvHeaders }
  ).catch(() => null);
  const centro = (centroRes && centroRes.ok) ? (await centroRes.json().catch(() => []))?.[0] : null;
  if (!centro) {
    return res.status(404).json({ error: 'Centro non collegato all\'organizzazione' });
  }

  // Turno attivo che copre lo slot: giorno, finestra Dal/Al, frequenza, griglia oraria
  const dow = new Date(data + 'T12:00:00').getDay();
  const oraMin = t2m(ora);
  const copre = (centro.turni || []).some(t => {
    if (t.giorno !== dow) return false;
    const dal = t.data_inizio_validita || null;
    const al  = t.data_fine_validita || null;
    if (dal && data < dal) return false;
    if (al && data > al) return false;
    const freq = t.frequenza_settimane || 1;
    if (freq > 1 && dal) {
      const diffW = Math.round((new Date(data + 'T12:00:00') - new Date(dal + 'T12:00:00')) / (7 * 24 * 3600 * 1000));
      if (diffW < 0 || diffW % freq !== 0) return false;
    }
    const ini = t2m(String(t.inizio).slice(0, 5));
    const fin = t2m(String(t.fine).slice(0, 5));
    const slot = Number(t.durata_slot) || 0;
    if (!slot) return false;
    return oraMin >= ini && (oraMin - ini) % slot === 0 && oraMin + slot <= fin;
  });
  if (!copre) {
    return res.status(422).json({ error: 'Nessun turno attivo copre questo orario' });
  }

  // Guardia ferie BLOCCANTE: chiusura del medico sulla data che tocca il centro (o tutti)
  const chRes = await fetch(
    `${supabaseUrl}/rest/v1/chiusure?medico_id=eq.${encodeURIComponent(medicoId)}&data_inizio=lte.${data}&data_fine=gte.${data}&select=centri_ids`,
    { headers: srvHeaders }
  ).catch(() => null);
  const chiusure = (chRes && chRes.ok) ? await chRes.json().catch(() => []) : null;
  if (!Array.isArray(chiusure)) {
    return res.status(500).json({ error: 'Verifica chiusure non riuscita' });
  }
  const inFerie = chiusure.some(ch => {
    const ids = ch.centri_ids || [];
    return ids.length === 0 || ids.some(cid => String(cid) === String(centroId));
  });
  if (inFerie) {
    return res.status(422).json({ error: 'Il medico è chiuso per ferie in questa data' });
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
