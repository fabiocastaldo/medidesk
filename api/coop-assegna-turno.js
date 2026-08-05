// api/coop-assegna-turno.js
// La regista assegna un turno a (medico, sede). L'endpoint garantisce il
// sede-centro del medico — ricicla il centro generico del join alla prima
// assegnazione (gli scrive coop_sede_id, nome e indirizzo della sede),
// crea un centro nuovo per le sedi successive — poi inserisce la riga in
// turni di quel centro. Da lì l'agenda del medico funziona con i renderer
// e il realtime esistenti: il dato è suo (medico_id), l'organizzazione è
// solo la mano che l'ha scritto. Tutto service_role, RLS invariata.

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
  const medicoId = String(b.medico_id || '');
  const sedeId = String(b.sede_id || '');
  const giorno = Number(b.giorno);
  const inizio = String(b.inizio || '');
  const fine = String(b.fine || '');
  const slot = Number(b.durata_slot || 20);
  const isUuid = (s) => /^[0-9a-fA-F-]{36}$/.test(s);
  const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  if (!isUuid(medicoId) || !isUuid(sedeId)) {
    return res.status(400).json({ error: 'Parametri non validi' });
  }
  if (!Number.isInteger(giorno) || giorno < 0 || giorno > 6) {
    return res.status(400).json({ error: 'Giorno non valido' });
  }
  if (!isTime(inizio) || !isTime(fine) || inizio >= fine) {
    return res.status(400).json({ error: 'Orario non valido' });
  }
  if (!Number.isInteger(slot) || slot < 5 || slot > 120) {
    return res.status(400).json({ error: 'Durata slot non valida' });
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
  const coopId = seg.cooperativa_id;

  // sede: deve appartenere all'organizzazione ed essere attiva
  const sedeRes = await fetch(
    `${supabaseUrl}/rest/v1/coop_sedi?id=eq.${encodeURIComponent(sedeId)}&cooperativa_id=eq.${encodeURIComponent(coopId)}&select=id,nome,via,citta,provincia,cap,attiva`,
    { headers: srvHeaders }
  ).catch(() => null);
  const sede = (sedeRes && sedeRes.ok) ? (await sedeRes.json().catch(() => []))?.[0] : null;
  if (!sede || sede.attiva === false) {
    return res.status(404).json({ error: 'Sede non trovata o non attiva' });
  }

  // il medico deve essere collegato all'organizzazione
  const collRes = await fetch(
    `${supabaseUrl}/rest/v1/centri?medico_id=eq.${encodeURIComponent(medicoId)}&cooperativa_id=eq.${encodeURIComponent(coopId)}&select=id,coop_sede_id&order=created_at.asc`,
    { headers: srvHeaders }
  ).catch(() => null);
  const collegati = (collRes && collRes.ok) ? await collRes.json().catch(() => []) : [];
  if (!collegati || !collegati.length) {
    return res.status(409).json({ error: 'Il medico non è collegato all\'organizzazione' });
  }

  // garantisce il sede-centro
  let centroId = null;
  const esistente = collegati.find(c => String(c.coop_sede_id) === String(sede.id));
  if (esistente) {
    centroId = esistente.id;
  } else {
    const generico = collegati.find(c => !c.coop_sede_id);
    if (generico) {
      const upRes = await fetch(
        `${supabaseUrl}/rest/v1/centri?id=eq.${encodeURIComponent(generico.id)}`,
        {
          method: 'PATCH',
          headers: { ...srvHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
          body: JSON.stringify({ coop_sede_id: sede.id, nome: sede.nome, via: sede.via, citta: sede.citta, provincia: sede.provincia, cap: sede.cap })
        }
      ).catch(() => null);
      const up = (upRes && upRes.ok) ? (await upRes.json().catch(() => []))?.[0] : null;
      if (!up?.id) {
        return res.status(500).json({ error: 'Promozione del centro non riuscita' });
      }
      centroId = up.id;
    } else {
      const insRes = await fetch(`${supabaseUrl}/rest/v1/centri`, {
        method: 'POST',
        headers: { ...srvHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({
          medico_id: medicoId, nome: sede.nome, gestione: 'cooperativa',
          cooperativa_id: coopId, coop_sede_id: sede.id,
          via: sede.via, citta: sede.citta, provincia: sede.provincia, cap: sede.cap,
          colore: '#0C726E', attivo: true
        })
      }).catch(() => null);
      const nuovo = (insRes && insRes.ok) ? (await insRes.json().catch(() => []))?.[0] : null;
      if (!nuovo?.id) {
        return res.status(500).json({ error: 'Creazione del centro sede non riuscita' });
      }
      centroId = nuovo.id;
    }
  }

  // inserisce il turno
  const turnoRes = await fetch(`${supabaseUrl}/rest/v1/turni`, {
    method: 'POST',
    headers: { ...srvHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({
      centro_id: centroId, giorno, inizio, fine, durata_slot: slot,
      frequenza_settimane: 1,
      data_inizio_validita: (b.data_inizio_validita && /^\d{4}-\d{2}-\d{2}$/.test(b.data_inizio_validita)) ? b.data_inizio_validita : new Date().toISOString().slice(0, 10),
      data_fine_validita: (b.data_fine_validita && /^\d{4}-\d{2}-\d{2}$/.test(b.data_fine_validita)) ? b.data_fine_validita : null
    })
  }).catch(() => null);
  const turno = (turnoRes && turnoRes.ok) ? (await turnoRes.json().catch(() => []))?.[0] : null;
  if (!turno?.id) {
    return res.status(500).json({ error: 'Creazione del turno non riuscita' });
  }

  return res.status(200).json({
    turno: { id: turno.id, giorno: turno.giorno, inizio: turno.inizio, fine: turno.fine },
    centro: { id: centroId, nome: sede.nome },
    sede: { id: sede.id, nome: sede.nome }
  });
}
