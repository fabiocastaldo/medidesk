// api/coop-compensi.js
// Riconciliazione compensi per la plancia organizzazione.
// Perimetro: identico a coop-statistiche — SOLO i sede-centri della cooperativa
// (centri.cooperativa_id), quindi solo medici attivati con codice, per costruzione.
// In uscita: aggregati economici per medico (maturato, liquidato, visite senza
// tariffa) più tariffe e servizi dell'organizzazione. Nessuna riga appuntamento,
// nessun dato del paziente attraversa il confine. Le scritture (tariffa,
// liquidato) sono vincolate al perimetro coop verificato server-side: medico e
// servizio devono appartenere alla cooperativa del chiamante.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function euroNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
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
  const coopId = seg.cooperativa_id;

  // sede-centri della cooperativa: definiscono i medici del perimetro
  const centriRes = await fetch(
    `${supabaseUrl}/rest/v1/centri?cooperativa_id=eq.${encodeURIComponent(coopId)}&select=id,medico_id`,
    { headers: srvHeaders }
  ).catch(() => null);
  let centri = (centriRes && centriRes.ok) ? await centriRes.json().catch(() => []) : [];
  if (!Array.isArray(centri)) centri = [];
  const mediciCoop = new Set(centri.filter(c => c.medico_id).map(c => String(c.medico_id).toLowerCase()));

  const jsonHeaders = { ...srvHeaders, 'Content-Type': 'application/json' };

  // ── POST: scritture perimetrate (tariffa | liquidato) ──
  if (req.method === 'POST') {
    const b = req.body || {};
    const azione = b.azione;
    const medicoId = typeof b.medico_id === 'string' ? b.medico_id : '';
    if (!UUID_RE.test(medicoId)) return res.status(400).json({ error: 'Parametro medico_id non valido' });
    if (!mediciCoop.has(medicoId.toLowerCase())) {
      return res.status(403).json({ error: 'Medico fuori dal perimetro dell\'organizzazione' });
    }

    if (azione === 'tariffa') {
      const servizioId = typeof b.servizio_id === 'string' ? b.servizio_id : '';
      if (!UUID_RE.test(servizioId)) return res.status(400).json({ error: 'Parametro servizio_id non valido' });
      const svRes = await fetch(
        `${supabaseUrl}/rest/v1/coop_servizi?id=eq.${encodeURIComponent(servizioId)}&cooperativa_id=eq.${encodeURIComponent(coopId)}&select=id`,
        { headers: srvHeaders }
      ).catch(() => null);
      const sv = (svRes && svRes.ok) ? await svRes.json().catch(() => []) : [];
      if (!Array.isArray(sv) || !sv.length) {
        return res.status(403).json({ error: 'Servizio fuori dal perimetro dell\'organizzazione' });
      }
      if (b.compenso === null || b.compenso === '' || b.compenso === undefined) {
        const delRes = await fetch(
          `${supabaseUrl}/rest/v1/coop_tariffe?cooperativa_id=eq.${encodeURIComponent(coopId)}&medico_id=eq.${encodeURIComponent(medicoId)}&servizio_id=eq.${encodeURIComponent(servizioId)}`,
          { method: 'DELETE', headers: { ...srvHeaders, 'Prefer': 'return=representation' } }
        ).catch(() => null);
        if (!delRes || !delRes.ok) return res.status(500).json({ error: 'Rimozione tariffa non riuscita' });
        const rows = await delRes.json().catch(() => []);
        return res.status(200).json({ ok: true, azione: 'tariffa', rimossa: Array.isArray(rows) ? rows.length : 0 });
      }
      const compenso = euroNum(b.compenso);
      if (compenso === null) return res.status(400).json({ error: 'Parametro compenso non valido' });
      const upRes = await fetch(
        `${supabaseUrl}/rest/v1/coop_tariffe?on_conflict=cooperativa_id,medico_id,servizio_id`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, 'Prefer': 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({ cooperativa_id: coopId, medico_id: medicoId, servizio_id: servizioId, compenso })
        }
      ).catch(() => null);
      if (!upRes || !upRes.ok) return res.status(500).json({ error: 'Salvataggio tariffa non riuscito' });
      const rows = await upRes.json().catch(() => []);
      const r = Array.isArray(rows) ? rows[0] : null;
      if (!r) return res.status(500).json({ error: 'Salvataggio tariffa non confermato' });
      return res.status(200).json({ ok: true, azione: 'tariffa', tariffa: { medico_id: r.medico_id, servizio_id: r.servizio_id, compenso: Number(r.compenso) } });
    }

    if (azione === 'liquidato') {
      const anno = Number(b.anno), mese = Number(b.mese);
      if (!Number.isInteger(anno) || anno < 2020 || anno > 2100) return res.status(400).json({ error: 'Parametro anno non valido' });
      if (!Number.isInteger(mese) || mese < 1 || mese > 12) return res.status(400).json({ error: 'Parametro mese non valido' });
      if (b.importo === null || b.importo === '' || b.importo === undefined) {
        const delRes = await fetch(
          `${supabaseUrl}/rest/v1/coop_compensi_liquidati?cooperativa_id=eq.${encodeURIComponent(coopId)}&medico_id=eq.${encodeURIComponent(medicoId)}&anno=eq.${anno}&mese=eq.${mese}`,
          { method: 'DELETE', headers: { ...srvHeaders, 'Prefer': 'return=representation' } }
        ).catch(() => null);
        if (!delRes || !delRes.ok) return res.status(500).json({ error: 'Rimozione importo non riuscita' });
        const rows = await delRes.json().catch(() => []);
        return res.status(200).json({ ok: true, azione: 'liquidato', rimossa: Array.isArray(rows) ? rows.length : 0 });
      }
      const importo = euroNum(b.importo);
      if (importo === null) return res.status(400).json({ error: 'Parametro importo non valido' });
      const upRes = await fetch(
        `${supabaseUrl}/rest/v1/coop_compensi_liquidati?on_conflict=cooperativa_id,medico_id,anno,mese`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, 'Prefer': 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({ cooperativa_id: coopId, medico_id: medicoId, anno, mese, importo })
        }
      ).catch(() => null);
      if (!upRes || !upRes.ok) return res.status(500).json({ error: 'Salvataggio importo non riuscito' });
      const rows = await upRes.json().catch(() => []);
      const r = Array.isArray(rows) ? rows[0] : null;
      if (!r) return res.status(500).json({ error: 'Salvataggio importo non confermato' });
      return res.status(200).json({ ok: true, azione: 'liquidato', liquidato: { medico_id: r.medico_id, anno: r.anno, mese: r.mese, importo: Number(r.importo) } });
    }

    return res.status(400).json({ error: 'Azione non valida' });
  }

  // ── GET ?anno=&mese=: quadro riconciliazione del mese ──
  const q = req.query || {};
  const anno = Number(q.anno), mese = Number(q.mese);
  if (!Number.isInteger(anno) || anno < 2020 || anno > 2100) return res.status(400).json({ error: 'Parametro anno non valido' });
  if (!Number.isInteger(mese) || mese < 1 || mese > 12) return res.status(400).json({ error: 'Parametro mese non valido' });

  const vuoto = { anno, mese, medici: [], servizi: [], tariffe: [] };
  if (!centri.length) return res.status(200).json(vuoto);

  const mm = String(mese).padStart(2, '0');
  const dal = `${anno}-${mm}-01`;
  const al = `${anno}-${mm}-${String(new Date(Date.UTC(anno, mese, 0)).getUTCDate()).padStart(2, '0')}`;

  const [svRes, tarRes, liqRes, appRes] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/coop_servizi?cooperativa_id=eq.${encodeURIComponent(coopId)}&select=id,nome,attivo`, { headers: srvHeaders }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/coop_tariffe?cooperativa_id=eq.${encodeURIComponent(coopId)}&select=medico_id,servizio_id,compenso`, { headers: srvHeaders }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/coop_compensi_liquidati?cooperativa_id=eq.${encodeURIComponent(coopId)}&anno=eq.${anno}&mese=eq.${mese}&select=medico_id,importo`, { headers: srvHeaders }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/appuntamenti?centro_id=in.(${centri.map(c => `"${c.id}"`).join(',')})&erogata=is.true&or=(cancelled.is.null,cancelled.eq.false)&data=gte.${dal}&data=lte.${al}&select=tipo_visita,medico_id`, { headers: srvHeaders }).catch(() => null)
  ]);
  if (!appRes || !appRes.ok) return res.status(500).json({ error: 'Lettura visite non riuscita' });

  const servizi = (svRes && svRes.ok) ? (await svRes.json().catch(() => [])) : [];
  const tariffe = (tarRes && tarRes.ok) ? (await tarRes.json().catch(() => [])) : [];
  const liquidati = (liqRes && liqRes.ok) ? (await liqRes.json().catch(() => [])) : [];
  const visite = await appRes.json().catch(() => []);

  const servizioIdPerNome = new Map();
  for (const s of (Array.isArray(servizi) ? servizi : [])) {
    servizioIdPerNome.set(String(s.nome || '').trim().toLowerCase(), String(s.id).toLowerCase());
  }
  const tariffaPerChiave = new Map();
  for (const t of (Array.isArray(tariffe) ? tariffe : [])) {
    tariffaPerChiave.set(`${String(t.medico_id).toLowerCase()}|${String(t.servizio_id).toLowerCase()}`, Number(t.compenso));
  }
  const liquidatoPerMedico = new Map();
  for (const l of (Array.isArray(liquidati) ? liquidati : [])) {
    liquidatoPerMedico.set(String(l.medico_id).toLowerCase(), Number(l.importo));
  }

  const maturato = new Map(), senzaTariffa = new Map();
  for (const v of (Array.isArray(visite) ? visite : [])) {
    const m = v.medico_id ? String(v.medico_id).toLowerCase() : '';
    if (!m) continue;
    const svId = servizioIdPerNome.get(String(v.tipo_visita || '').trim().toLowerCase());
    const comp = svId != null ? tariffaPerChiave.get(`${m}|${svId}`) : undefined;
    if (comp == null || !Number.isFinite(comp)) {
      senzaTariffa.set(m, (senzaTariffa.get(m) || 0) + 1);
    } else {
      maturato.set(m, (maturato.get(m) || 0) + comp);
    }
  }

  // risoluzione nomi (soli id → etichette; nessun dato paziente)
  const medNomi = new Map();
  if (mediciCoop.size) {
    const inMed = [...mediciCoop].map(id => `"${id}"`).join(',');
    const mr = await fetch(
      `${supabaseUrl}/rest/v1/medici?id=in.(${inMed})&select=id,titolo,nome,cognome`,
      { headers: srvHeaders }
    ).catch(() => null);
    const mrows = (mr && mr.ok) ? await mr.json().catch(() => []) : [];
    for (const m of (Array.isArray(mrows) ? mrows : [])) {
      medNomi.set(String(m.id).toLowerCase(), [m.titolo, m.nome, m.cognome].filter(Boolean).join(' ').trim() || 'Medico');
    }
  }

  const medici = [...mediciCoop].map(id => ({
    medico_id: id,
    nome: medNomi.get(id) || 'Medico',
    maturato: Math.round(((maturato.get(id) || 0) + Number.EPSILON) * 100) / 100,
    senza_tariffa: senzaTariffa.get(id) || 0,
    liquidato: liquidatoPerMedico.has(id) ? liquidatoPerMedico.get(id) : null
  })).sort((a, b) => b.maturato - a.maturato || a.nome.localeCompare(b.nome));

  return res.status(200).json({
    anno, mese, medici,
    servizi: (Array.isArray(servizi) ? servizi : []).map(s => ({ id: s.id, nome: s.nome, attivo: s.attivo !== false })),
    tariffe: (Array.isArray(tariffe) ? tariffe : []).map(t => ({ medico_id: t.medico_id, servizio_id: t.servizio_id, compenso: Number(t.compenso) }))
  });
}
