// api/coop-join.js
// Riscatto del codice di collegamento da parte di un medico autenticato.
// Effetto: il codice viene marcato usato (claim atomico su used_at IS NULL)
// e viene creato un centro gestione='cooperativa' intestato al medico,
// agganciato alla cooperativa (centri.cooperativa_id).
// Nessun gate trial: il join non consuma il motore premium (criterio permanente).

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

  // normalizzazione: maiuscole, via i separatori, riformattato CP-XXXX-XXXX
  const raw = String(req.body?.codice || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw.startsWith('CP') || raw.length !== 10) {
    return res.status(400).json({ error: 'Codice non valido' });
  }
  const codice = `CP-${raw.slice(2, 6)}-${raw.slice(6)}`;

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

  const medicoRes = await fetch(
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&select=id,stato`,
    { headers: srvHeaders }
  ).catch(() => null);
  if (!medicoRes || !medicoRes.ok) {
    return res.status(403).json({ error: 'Verifica account fallita' });
  }
  const medico = (await medicoRes.json().catch(() => []))?.[0];
  if (!medico) {
    return res.status(403).json({ error: 'Profilo medico non trovato' });
  }
  if (medico.stato !== 'approvato') {
    return res.status(403).json({ error: 'Il collegamento è disponibile per gli account approvati' });
  }

  // codice: esistenza e validità
  const codeRes = await fetch(
    `${supabaseUrl}/rest/v1/coop_codici?codice=eq.${encodeURIComponent(codice)}&select=id,cooperativa_id,expires_at,used_at`,
    { headers: srvHeaders }
  ).catch(() => null);
  if (!codeRes || !codeRes.ok) {
    return res.status(500).json({ error: 'Verifica codice fallita' });
  }
  const codeRow = (await codeRes.json().catch(() => []))?.[0];
  if (!codeRow) {
    return res.status(404).json({ error: 'Codice inesistente' });
  }
  if (codeRow.used_at) {
    return res.status(409).json({ error: 'Codice già utilizzato' });
  }
  if (new Date(codeRow.expires_at).getTime() <= Date.now()) {
    return res.status(410).json({ error: 'Codice scaduto' });
  }

  // cooperativa attiva
  const coopRes = await fetch(
    `${supabaseUrl}/rest/v1/cooperative?id=eq.${encodeURIComponent(codeRow.cooperativa_id)}&select=id,nome,stato`,
    { headers: srvHeaders }
  ).catch(() => null);
  const coop = (coopRes && coopRes.ok) ? (await coopRes.json().catch(() => []))?.[0] : null;
  if (!coop || coop.stato !== 'attiva') {
    return res.status(403).json({ error: 'Cooperativa non attiva' });
  }

  // già collegato?
  const dupRes = await fetch(
    `${supabaseUrl}/rest/v1/centri?medico_id=eq.${encodeURIComponent(medico.id)}&cooperativa_id=eq.${encodeURIComponent(coop.id)}&select=id`,
    { headers: srvHeaders }
  ).catch(() => null);
  const dup = (dupRes && dupRes.ok) ? await dupRes.json().catch(() => []) : [];
  if (dup && dup.length) {
    return res.status(409).json({ error: 'Sei già collegato a questa cooperativa' });
  }

  // claim atomico: vince chi trova used_at ancora NULL
  const claimRes = await fetch(
    `${supabaseUrl}/rest/v1/coop_codici?id=eq.${encodeURIComponent(codeRow.id)}&used_at=is.null`,
    {
      method: 'PATCH',
      headers: { ...srvHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ used_at: new Date().toISOString(), used_by_medico: medico.id })
    }
  ).catch(() => null);
  const claimed = (claimRes && claimRes.ok) ? await claimRes.json().catch(() => []) : [];
  if (!claimed || !claimed.length) {
    return res.status(409).json({ error: 'Codice già utilizzato' });
  }

  // creazione centro cooperativa
  const insRes = await fetch(`${supabaseUrl}/rest/v1/centri`, {
    method: 'POST',
    headers: { ...srvHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({
      medico_id: medico.id,
      nome: coop.nome,
      gestione: 'cooperativa',
      cooperativa_id: coop.id,
      colore: '#0C726E',
      attivo: true
    })
  }).catch(() => null);
  const centro = (insRes && insRes.ok) ? (await insRes.json().catch(() => []))?.[0] : null;
  if (!centro?.id) {
    // revert best-effort del claim per non bruciare il codice
    await fetch(`${supabaseUrl}/rest/v1/coop_codici?id=eq.${encodeURIComponent(codeRow.id)}`, {
      method: 'PATCH',
      headers: { ...srvHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ used_at: null, used_by_medico: null })
    }).catch(() => null);
    return res.status(500).json({ error: 'Creazione del collegamento non riuscita' });
  }

  return res.status(200).json({
    cooperativa: { id: coop.id, nome: coop.nome },
    centro: { id: centro.id, nome: centro.nome }
  });
}
