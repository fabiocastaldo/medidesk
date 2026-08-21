// api/coop-cancella.js
// Roadmap plancia voce 1 — ciclo di vita appuntamento dalla plancia (tappa 1: cancellazione).
// La segreteria della cooperativa identifica l'occupante di uno slot (lookup) e
// cancella l'appuntamento (cancel) sui sede-centri coop. Perimetro SEMPRE
// rivalidato server-side: il centro dell'appuntamento deve appartenere alla
// cooperativa del chiamante; l'id dell'appuntamento è accettato SOLO dopo la
// verifica del perimetro. Nessun cutoff 2h: la struttura è titolare dell'agenda
// (il cutoff resta sul solo canale pubblico del paziente).
//
// POST { action:'lookup', centro_id, data, ora }
//   → 200 { appt:{ id, nome_paziente, cognome_paziente, tipo_visita, per_conto, email_presente } }
//   → 404 { error:'not_found' } (slot libero o fuori perimetro)
// POST { action:'cancel', appt_id }
//   → 200 { ok:true, riprenota:{ nome, cognome, telefono, email } }
//   → 409 { error:'gia_cancellato' }
//
// Effetti best-effort dopo il cancel (soft-fail, mai bloccanti):
//   1) notifica_medico_cancellazione (gate su medici.mail_medico_cancellazione, lato send-email)
//   2) cancellazione_paziente_coop al paziente (solo se ha email)
//   3) hook lista d'attesa — replicato da api/cancel-appointment.js righe 138-178
//      (chiude l'asimmetria: prima scattava solo dal cancel pubblico). Scatta
//      solo se lo slot liberato è futuro. TODO(refactor): estrarre in modulo
//      condiviso api/_waitlist.js e importarlo da entrambi gli endpoint.

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
    `${supabaseUrl}/rest/v1/segreterie?user_id=eq.${encodeURIComponent(userData.id)}&select=stato,cooperativa_id,cooperative(id,stato)`,
    { headers: srvHeaders }
  ).catch(() => null);
  const seg = (segRes && segRes.ok) ? (await segRes.json().catch(() => []))?.[0] : null;
  if (!seg || seg.stato !== 'attiva' || !seg.cooperative || seg.cooperative.stato !== 'attiva') {
    return res.status(403).json({ error: 'Account non abilitato' });
  }

  const sb = (path, init = {}) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...srvHeaders, ...(init.headers || {}) }
  });

  const b = req.body || {};
  const action = typeof b.action === 'string' ? b.action : '';

  try {
    if (action === 'lookup') {
      const centroId = clean(b.centro_id, 64);
      const data     = clean(b.data, 10);
      const ora      = clean(b.ora, 5);
      if (!centroId || !/^\d{4}-\d{2}-\d{2}$/.test(data) || !/^\d{2}:\d{2}$/.test(ora)) {
        return res.status(400).json({ error: 'Parametri non validi' });
      }
      // Perimetro PRIMA del match: il centro deve appartenere alla cooperativa del chiamante
      const cRes = await sb(`centri?id=eq.${encodeURIComponent(centroId)}&cooperativa_id=eq.${encodeURIComponent(seg.cooperativa_id)}&select=id&limit=1`);
      if (!cRes.ok) return res.status(500).json({ error: 'Errore server' });
      const cRow = (await cRes.json().catch(() => []))?.[0];
      if (!cRow) return res.status(404).json({ error: 'not_found' });
      // `ora` in DB non è normalizzata (HH:MM o HH:MM:SS): filtro centro+data, match ora in JS
      const aRes = await sb(`appuntamenti?centro_id=eq.${encodeURIComponent(centroId)}&data=eq.${data}&or=(cancelled.is.null,cancelled.eq.false)&select=id,nome_paziente,cognome_paziente,tipo_visita,per_conto,ora,email_paziente`);
      if (!aRes.ok) return res.status(500).json({ error: 'Errore server' });
      const rows = await aRes.json().catch(() => []);
      const appt = (Array.isArray(rows) ? rows : []).find(a => String(a.ora || '').slice(0, 5) === ora);
      if (!appt) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ appt: {
        id: appt.id,
        nome_paziente: appt.nome_paziente || '',
        cognome_paziente: appt.cognome_paziente || '',
        tipo_visita: appt.tipo_visita || '',
        per_conto: !!appt.per_conto,
        email_presente: !!appt.email_paziente
      } });
    }

    if (action === 'cancel') {
      const apptId = clean(b.appt_id, 64);
      if (!apptId) return res.status(400).json({ error: 'Parametri non validi' });
      // Perimetro via join: l'appuntamento deve stare su un centro della cooperativa del chiamante
      const r0 = await sb(
        `appuntamenti?id=eq.${encodeURIComponent(apptId)}` +
        `&select=id,data,ora,cancelled,medico_id,centro_id,nome_paziente,cognome_paziente,telefono_paziente,email_paziente,cancellation_token,centri!inner(cooperativa_id)` +
        `&centri.cooperativa_id=eq.${encodeURIComponent(seg.cooperativa_id)}&limit=1`
      );
      if (!r0.ok) return res.status(500).json({ error: 'Errore server' });
      const appt0 = (await r0.json().catch(() => []))?.[0];
      if (!appt0) return res.status(404).json({ error: 'not_found' });
      if (appt0.cancelled) return res.status(409).json({ error: 'gia_cancellato' });

      // UPDATE con guardia cancelled=false + RETURNING (la corsa la vince uno solo)
      const r1 = await sb(
        `appuntamenti?id=eq.${encodeURIComponent(apptId)}&cancelled=eq.false`,
        {
          method: 'PATCH',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify({ cancelled: true, cancelled_at: new Date().toISOString() })
        }
      );
      if (!r1.ok) return res.status(500).json({ error: 'Errore server' });
      const updated = await r1.json().catch(() => []);
      if (!Array.isArray(updated) || updated.length === 0) {
        return res.status(409).json({ error: 'gia_cancellato' });
      }

      const host = req.headers['x-forwarded-host'] || req.headers.host;

      // 1) notifica al medico (gate server-side su medici.mail_medico_cancellazione)
      try {
        if (host) {
          await fetch(`https://${host}/api/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tipo: 'notifica_medico_cancellazione', appt_id: appt0.id, cancellation_token: appt0.cancellation_token })
          }).catch(() => {});
        }
      } catch { /* soft-fail */ }

      // 2) avviso al paziente (solo se ha email)
      try {
        if (host && appt0.email_paziente) {
          await fetch(`https://${host}/api/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tipo: 'cancellazione_paziente_coop', appt_id: appt0.id, cancellation_token: appt0.cancellation_token })
          }).catch(() => {});
        }
      } catch { /* soft-fail */ }

      // 3) hook lista d'attesa — replica di api/cancel-appointment.js (v1):
      // avvisa gli iscritti attivi dello stesso medico+centro il cui appuntamento
      // (non cancellato) è a data/ora successiva allo slot liberato. Solo slot
      // futuri, best-effort, cap 10 destinatari.
      try {
        const oraSlot = String(appt0.ora || '00:00').slice(0, 5);
        const slotTs = `${appt0.data}T${oraSlot}`;
        const nowTs = new Date().toLocaleDateString('en-CA') + 'T' +
                      String(new Date().getHours()).padStart(2, '0') + ':' +
                      String(new Date().getMinutes()).padStart(2, '0');
        if (host && appt0.medico_id && slotTs > nowTs) {
          const q = `lista_attesa?attivo=eq.true&medico_id=eq.${encodeURIComponent(appt0.medico_id)}` +
                    (appt0.centro_id ? `&centro_id=eq.${encodeURIComponent(appt0.centro_id)}` : '') +
                    `&select=id,appuntamento_id,appuntamenti!inner(id,data,ora,cancelled,cancellation_token)` +
                    `&appuntamenti.cancelled=eq.false&limit=50`;
          const rw = await sb(q);
          if (rw.ok) {
            const subs = await rw.json().catch(() => []);
            const targets = (Array.isArray(subs) ? subs : [])
              .filter(s => {
                const a = s.appuntamenti;
                if (!a || a.cancelled || !a.data) return false;
                const ts = `${a.data}T${String(a.ora || '00:00').slice(0, 5)}`;
                return ts > slotTs;
              })
              .slice(0, 10);
            for (const s of targets) {
              await fetch(`https://${host}/api/send-email`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  tipo: 'avviso_lista_attesa',
                  appt_id: s.appuntamenti.id,
                  cancellation_token: s.appuntamenti.cancellation_token,
                  slot_data: appt0.data,
                  slot_ora: oraSlot
                })
              }).catch(() => {});
              await sb(`lista_attesa?id=eq.${encodeURIComponent(s.id)}`, {
                method: 'PATCH',
                body: JSON.stringify({ notified_at: new Date().toISOString() })
              }).catch(() => {});
            }
          }
        }
      } catch { /* soft-fail */ }

      // dati minimi per la riprogrammazione in un gesto (solo nel response del
      // cancel, mai nel lookup: minimizzazione — servono solo per riprenotare)
      return res.status(200).json({ ok: true, riprenota: {
        nome: appt0.nome_paziente || '',
        cognome: appt0.cognome_paziente || '',
        telefono: appt0.telefono_paziente || '',
        email: appt0.email_paziente || ''
      } });
    }

    return res.status(400).json({ error: 'Azione non valida' });
  } catch (e) {
    console.error('[coop-cancella]', e.message);
    return res.status(500).json({ error: 'Errore server' });
  }
}
