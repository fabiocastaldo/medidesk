// api/coop-servizi.js
// Gestione del catalogo servizi dell'organizzazione e delle associazioni
// medico<->servizio. Tre azioni: crea | associa | rimuovi.
// Auth: JWT regista -> segreterie(attiva) -> cooperative(attiva). Tutto service_role.

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
  const action = String(b.action || '');
  const isUuid = (s) => /^[0-9a-fA-F-]{36}$/.test(String(s || ''));

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
    `${supabaseUrl}/rest/v1/segreterie?user_id=eq.${encodeURIComponent(userData.id)}&select=stato,ruolo,cooperativa_id,cooperative(id,stato)`,
    { headers: srvHeaders }
  ).catch(() => null);
  const seg = (segRes && segRes.ok) ? (await segRes.json().catch(() => []))?.[0] : null;
  if (!seg || seg.stato !== 'attiva' || !seg.cooperative || seg.cooperative.stato !== 'attiva') {
    return res.status(403).json({ error: 'Account non abilitato' });
  }
  if (seg.ruolo !== 'admin') {
    return res.status(403).json({ error: 'Operazione riservata all\'amministratore' });
  }
  const coopId = seg.cooperativa_id;

  if (action === 'crea') {
    const nome = String(b.nome || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!nome) {
      return res.status(400).json({ error: 'Il nome del servizio è obbligatorio' });
    }
    const insRes = await fetch(`${supabaseUrl}/rest/v1/coop_servizi`, {
      method: 'POST',
      headers: { ...srvHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ cooperativa_id: coopId, nome })
    }).catch(() => null);
    const servizio = (insRes && insRes.ok) ? (await insRes.json().catch(() => []))?.[0] : null;
    if (!servizio?.id) {
      return res.status(500).json({ error: 'Creazione servizio non riuscita' });
    }
    return res.status(200).json({ servizio });
  }

  if (action === 'rinomina' || action === 'elimina') {
    const servizioId = String(b.servizio_id || '');
    if (!isUuid(servizioId)) {
      return res.status(400).json({ error: 'Parametri non validi' });
    }
    const svRes = await fetch(
      `${supabaseUrl}/rest/v1/coop_servizi?id=eq.${encodeURIComponent(servizioId)}&cooperativa_id=eq.${encodeURIComponent(coopId)}&select=id`,
      { headers: srvHeaders }
    ).catch(() => null);
    const sv = (svRes && svRes.ok) ? (await svRes.json().catch(() => []))?.[0] : null;
    if (!sv) {
      return res.status(404).json({ error: 'Servizio non trovato' });
    }
    if (action === 'rinomina') {
      const nome = String(b.nome || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!nome) {
        return res.status(400).json({ error: 'Il nome del servizio è obbligatorio' });
      }
      const upRes = await fetch(
        `${supabaseUrl}/rest/v1/coop_servizi?id=eq.${encodeURIComponent(servizioId)}`,
        { method: 'PATCH', headers: { ...srvHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, body: JSON.stringify({ nome }) }
      ).catch(() => null);
      const up = (upRes && upRes.ok) ? (await upRes.json().catch(() => []))?.[0] : null;
      if (!up?.id) {
        return res.status(500).json({ error: 'Rinomina non riuscita' });
      }
      return res.status(200).json({ servizio: up });
    }
    const delRes = await fetch(
      `${supabaseUrl}/rest/v1/coop_servizi?id=eq.${encodeURIComponent(servizioId)}`,
      { method: 'DELETE', headers: { ...srvHeaders, 'Prefer': 'return=representation' } }
    ).catch(() => null);
    const removed = (delRes && delRes.ok) ? await delRes.json().catch(() => []) : [];
    if (!removed || !removed.length) {
      return res.status(500).json({ error: 'Eliminazione non riuscita' });
    }
    return res.status(200).json({ eliminato: true });
  }

  if (action === 'associa' || action === 'rimuovi') {
    const servizioId = String(b.servizio_id || '');
    const medicoId = String(b.medico_id || '');
    if (!isUuid(servizioId) || !isUuid(medicoId)) {
      return res.status(400).json({ error: 'Parametri non validi' });
    }
    // il servizio deve appartenere all'organizzazione
    const svRes = await fetch(
      `${supabaseUrl}/rest/v1/coop_servizi?id=eq.${encodeURIComponent(servizioId)}&cooperativa_id=eq.${encodeURIComponent(coopId)}&select=id`,
      { headers: srvHeaders }
    ).catch(() => null);
    const sv = (svRes && svRes.ok) ? (await svRes.json().catch(() => []))?.[0] : null;
    if (!sv) {
      return res.status(404).json({ error: 'Servizio non trovato' });
    }

    if (action === 'associa') {
      // il medico deve essere collegato all'organizzazione
      const collRes = await fetch(
        `${supabaseUrl}/rest/v1/centri?medico_id=eq.${encodeURIComponent(medicoId)}&cooperativa_id=eq.${encodeURIComponent(coopId)}&select=id&limit=1`,
        { headers: srvHeaders }
      ).catch(() => null);
      const coll = (collRes && collRes.ok) ? await collRes.json().catch(() => []) : [];
      if (!coll || !coll.length) {
        return res.status(409).json({ error: 'Il medico non è collegato all\'organizzazione' });
      }
      const insRes = await fetch(`${supabaseUrl}/rest/v1/coop_servizi_medici`, {
        method: 'POST',
        headers: { ...srvHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ servizio_id: servizioId, medico_id: medicoId })
      }).catch(() => null);
      if (insRes && insRes.status === 409) {
        return res.status(409).json({ error: 'Il medico è già associato a questo servizio' });
      }
      const assoc = (insRes && insRes.ok) ? (await insRes.json().catch(() => []))?.[0] : null;
      if (!assoc?.id) {
        return res.status(500).json({ error: 'Associazione non riuscita' });
      }
      return res.status(200).json({ associazione: assoc });
    }

    // rimuovi
    const delRes = await fetch(
      `${supabaseUrl}/rest/v1/coop_servizi_medici?servizio_id=eq.${encodeURIComponent(servizioId)}&medico_id=eq.${encodeURIComponent(medicoId)}`,
      { method: 'DELETE', headers: { ...srvHeaders, 'Prefer': 'return=representation' } }
    ).catch(() => null);
    const removed = (delRes && delRes.ok) ? await delRes.json().catch(() => []) : [];
    if (!removed || !removed.length) {
      return res.status(404).json({ error: 'Associazione non trovata' });
    }
    return res.status(200).json({ rimossa: true });
  }

  return res.status(400).json({ error: 'Azione non riconosciuta' });
}
