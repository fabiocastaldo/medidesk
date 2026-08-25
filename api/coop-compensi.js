// api/coop-compensi.js
// Compensi per la plancia organizzazione — modello per SEDE (chi paga chi).
// Ogni coop_sedi ha modello_compensi: 'centro_paga' (il centro paga il medico),
// 'medico_versa' (il medico riconosce una quota al centro), 'nessuno' (default).
// Perimetro: identico a coop-statistiche — SOLO i sede-centri della cooperativa
// (centri.cooperativa_id), quindi solo medici attivati con codice, per costruzione.
// Il maturato del medico si IMPORTA dal suo listino (prestazioni_centro) letto
// ESCLUSIVAMENTE sui sede-centri della cooperativa: i centri privati del medico
// non entrano mai qui. La replica della vigenza è quella del rendiconto medico:
// candidate = stesso centro + stesso tipo_visita + valido_dal <= data visita,
// vince il valido_dal più recente; percentuale senza prezzo = tariffa assente.
// In uscita: SOLO aggregati economici per sede×medico. Nessuna riga appuntamento,
// nessun dato del paziente attraversa il confine. Le scritture (modello, regola,
// regola_tutti, liquidato) sono vincolate al perimetro coop verificato server-side.
// Regole quota (medico_versa): percentuale sul PREZZO PIENO della visita (dal
// listino del medico, vigente per data), fisso a visita, o canone mensile fisso.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODELLI = ['centro_paga', 'medico_versa', 'nessuno'];
const REGOLA_TIPI = ['percentuale', 'fisso', 'mensile'];

function euroNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
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

  // sede-centri della cooperativa: perimetro medici + mappa centro→sede
  const centriRes = await fetch(
    `${supabaseUrl}/rest/v1/centri?cooperativa_id=eq.${encodeURIComponent(coopId)}&select=id,medico_id,coop_sede_id`,
    { headers: srvHeaders }
  ).catch(() => null);
  let centri = (centriRes && centriRes.ok) ? await centriRes.json().catch(() => []) : [];
  if (!Array.isArray(centri)) centri = [];
  const mediciCoop = new Set(centri.filter(c => c.medico_id).map(c => String(c.medico_id).toLowerCase()));
  // coppie sede×medico esistenti (solo centri agganciati a una sede)
  const coppie = new Set(
    centri
      .filter(c => c.medico_id && c.coop_sede_id)
      .map(c => `${String(c.coop_sede_id).toLowerCase()}|${String(c.medico_id).toLowerCase()}`)
  );

  const jsonHeaders = { ...srvHeaders, 'Content-Type': 'application/json' };

  // ── POST: scritture perimetrate (modello | regola | liquidato) ──
  if (req.method === 'POST') {
    const b = req.body || {};
    const azione = b.azione;

    if (azione === 'modello') {
      const sedeId = typeof b.sede_id === 'string' ? b.sede_id : '';
      if (!UUID_RE.test(sedeId)) return res.status(400).json({ error: 'Parametro sede_id non valido' });
      const modello = typeof b.modello === 'string' ? b.modello : '';
      if (!MODELLI.includes(modello)) return res.status(400).json({ error: 'Parametro modello non valido' });
      const upRes = await fetch(
        `${supabaseUrl}/rest/v1/coop_sedi?id=eq.${encodeURIComponent(sedeId)}&cooperativa_id=eq.${encodeURIComponent(coopId)}`,
        {
          method: 'PATCH',
          headers: { ...jsonHeaders, 'Prefer': 'return=representation' },
          body: JSON.stringify({ modello_compensi: modello })
        }
      ).catch(() => null);
      if (!upRes || !upRes.ok) return res.status(500).json({ error: 'Salvataggio modello non riuscito' });
      const rows = await upRes.json().catch(() => []);
      const r = Array.isArray(rows) ? rows[0] : null;
      if (!r) return res.status(403).json({ error: 'Sede fuori dal perimetro dell\'organizzazione' });
      return res.status(200).json({ ok: true, azione: 'modello', sede: { sede_id: r.id, modello: r.modello_compensi } });
    }

    if (azione === 'regola_tutti') {
      const sedeId = typeof b.sede_id === 'string' ? b.sede_id : '';
      if (!UUID_RE.test(sedeId)) return res.status(400).json({ error: 'Parametro sede_id non valido' });
      const mediciSede = [...coppie].filter(k => k.startsWith(`${sedeId.toLowerCase()}|`)).map(k => k.split('|')[1]);
      if (!mediciSede.length) return res.status(403).json({ error: 'Nessun medico collegato a questa sede' });
      if (b.valore === null || b.valore === '' || b.valore === undefined) {
        const delRes = await fetch(
          `${supabaseUrl}/rest/v1/coop_regole_compensi?cooperativa_id=eq.${encodeURIComponent(coopId)}&sede_id=eq.${encodeURIComponent(sedeId)}`,
          { method: 'DELETE', headers: { ...srvHeaders, 'Prefer': 'return=representation' } }
        ).catch(() => null);
        if (!delRes || !delRes.ok) return res.status(500).json({ error: 'Rimozione regole non riuscita' });
        const rows = await delRes.json().catch(() => []);
        return res.status(200).json({ ok: true, azione: 'regola_tutti', rimosse: Array.isArray(rows) ? rows.length : 0 });
      }
      const tipo = typeof b.tipo === 'string' ? b.tipo : '';
      if (!REGOLA_TIPI.includes(tipo)) return res.status(400).json({ error: 'Parametro tipo non valido' });
      const valore = euroNum(b.valore);
      if (valore === null) return res.status(400).json({ error: 'Parametro valore non valido' });
      if (tipo === 'percentuale' && valore > 100) return res.status(400).json({ error: 'La percentuale non pu\u00f2 superare 100' });
      const upRes = await fetch(
        `${supabaseUrl}/rest/v1/coop_regole_compensi?on_conflict=cooperativa_id,medico_id,sede_id`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, 'Prefer': 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify(mediciSede.map(m => ({ cooperativa_id: coopId, medico_id: m, sede_id: sedeId, tipo, valore })))
        }
      ).catch(() => null);
      if (!upRes || !upRes.ok) return res.status(500).json({ error: 'Salvataggio regole non riuscito' });
      const rows = await upRes.json().catch(() => []);
      if (!Array.isArray(rows) || rows.length !== mediciSede.length) return res.status(500).json({ error: 'Salvataggio regole non confermato' });
      return res.status(200).json({ ok: true, azione: 'regola_tutti', applicate: rows.length });
    }

    // regola e liquidato: richiedono medico e sede nel perimetro, con coppia esistente
    const medicoId = typeof b.medico_id === 'string' ? b.medico_id : '';
    const sedeId = typeof b.sede_id === 'string' ? b.sede_id : '';
    if (!UUID_RE.test(medicoId)) return res.status(400).json({ error: 'Parametro medico_id non valido' });
    if (!UUID_RE.test(sedeId)) return res.status(400).json({ error: 'Parametro sede_id non valido' });
    if (!mediciCoop.has(medicoId.toLowerCase())) {
      return res.status(403).json({ error: 'Medico fuori dal perimetro dell\'organizzazione' });
    }
    if (!coppie.has(`${sedeId.toLowerCase()}|${medicoId.toLowerCase()}`)) {
      return res.status(403).json({ error: 'Il medico non opera su questa sede' });
    }

    if (azione === 'regola') {
      if (b.valore === null || b.valore === '' || b.valore === undefined) {
        const delRes = await fetch(
          `${supabaseUrl}/rest/v1/coop_regole_compensi?cooperativa_id=eq.${encodeURIComponent(coopId)}&medico_id=eq.${encodeURIComponent(medicoId)}&sede_id=eq.${encodeURIComponent(sedeId)}`,
          { method: 'DELETE', headers: { ...srvHeaders, 'Prefer': 'return=representation' } }
        ).catch(() => null);
        if (!delRes || !delRes.ok) return res.status(500).json({ error: 'Rimozione regola non riuscita' });
        const rows = await delRes.json().catch(() => []);
        return res.status(200).json({ ok: true, azione: 'regola', rimossa: Array.isArray(rows) ? rows.length : 0 });
      }
      const tipo = typeof b.tipo === 'string' ? b.tipo : '';
      if (!REGOLA_TIPI.includes(tipo)) return res.status(400).json({ error: 'Parametro tipo non valido' });
      const valore = euroNum(b.valore);
      if (valore === null) return res.status(400).json({ error: 'Parametro valore non valido' });
      if (tipo === 'percentuale' && valore > 100) return res.status(400).json({ error: 'La percentuale non può superare 100' });
      const upRes = await fetch(
        `${supabaseUrl}/rest/v1/coop_regole_compensi?on_conflict=cooperativa_id,medico_id,sede_id`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, 'Prefer': 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({ cooperativa_id: coopId, medico_id: medicoId, sede_id: sedeId, tipo, valore })
        }
      ).catch(() => null);
      if (!upRes || !upRes.ok) return res.status(500).json({ error: 'Salvataggio regola non riuscito' });
      const rows = await upRes.json().catch(() => []);
      const r = Array.isArray(rows) ? rows[0] : null;
      if (!r) return res.status(500).json({ error: 'Salvataggio regola non confermato' });
      return res.status(200).json({ ok: true, azione: 'regola', regola: { medico_id: r.medico_id, sede_id: r.sede_id, tipo: r.tipo, valore: Number(r.valore) } });
    }

    if (azione === 'liquidato') {
      const anno = Number(b.anno), mese = Number(b.mese);
      if (!Number.isInteger(anno) || anno < 2020 || anno > 2100) return res.status(400).json({ error: 'Parametro anno non valido' });
      if (!Number.isInteger(mese) || mese < 1 || mese > 12) return res.status(400).json({ error: 'Parametro mese non valido' });
      if (b.importo === null || b.importo === '' || b.importo === undefined) {
        const delRes = await fetch(
          `${supabaseUrl}/rest/v1/coop_compensi_liquidati?cooperativa_id=eq.${encodeURIComponent(coopId)}&medico_id=eq.${encodeURIComponent(medicoId)}&sede_id=eq.${encodeURIComponent(sedeId)}&anno=eq.${anno}&mese=eq.${mese}`,
          { method: 'DELETE', headers: { ...srvHeaders, 'Prefer': 'return=representation' } }
        ).catch(() => null);
        if (!delRes || !delRes.ok) return res.status(500).json({ error: 'Rimozione importo non riuscita' });
        const rows = await delRes.json().catch(() => []);
        return res.status(200).json({ ok: true, azione: 'liquidato', rimossa: Array.isArray(rows) ? rows.length : 0 });
      }
      const importo = euroNum(b.importo);
      if (importo === null) return res.status(400).json({ error: 'Parametro importo non valido' });
      const upRes = await fetch(
        `${supabaseUrl}/rest/v1/coop_compensi_liquidati?on_conflict=cooperativa_id,medico_id,sede_id,anno,mese`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, 'Prefer': 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({ cooperativa_id: coopId, medico_id: medicoId, sede_id: sedeId, anno, mese, importo })
        }
      ).catch(() => null);
      if (!upRes || !upRes.ok) return res.status(500).json({ error: 'Salvataggio importo non riuscito' });
      const rows = await upRes.json().catch(() => []);
      const r = Array.isArray(rows) ? rows[0] : null;
      if (!r) return res.status(500).json({ error: 'Salvataggio importo non confermato' });
      return res.status(200).json({ ok: true, azione: 'liquidato', liquidato: { medico_id: r.medico_id, sede_id: r.sede_id, anno: r.anno, mese: r.mese, importo: Number(r.importo) } });
    }

    return res.status(400).json({ error: 'Azione non valida' });
  }

  // ── GET ?anno=&mese=: quadro del mese, raggruppabile per verso ──
  const q = req.query || {};
  const anno = Number(q.anno), mese = Number(q.mese);
  if (!Number.isInteger(anno) || anno < 2020 || anno > 2100) return res.status(400).json({ error: 'Parametro anno non valido' });
  if (!Number.isInteger(mese) || mese < 1 || mese > 12) return res.status(400).json({ error: 'Parametro mese non valido' });

  const sedRes = await fetch(
    `${supabaseUrl}/rest/v1/coop_sedi?cooperativa_id=eq.${encodeURIComponent(coopId)}&select=id,nome,attiva,modello_compensi&order=created_at.asc`,
    { headers: srvHeaders }
  ).catch(() => null);
  let sedi = (sedRes && sedRes.ok) ? await sedRes.json().catch(() => []) : [];
  if (!Array.isArray(sedi)) sedi = [];
  const modelloDiSede = new Map(sedi.map(s => [String(s.id).toLowerCase(), s.modello_compensi || 'nessuno']));

  const mm = String(mese).padStart(2, '0');
  const dal = `${anno}-${mm}-01`;
  const al = `${anno}-${mm}-${String(new Date(Date.UTC(anno, mese, 0)).getUTCDate()).padStart(2, '0')}`;

  const vuoto = {
    anno, mese,
    sedi: sedi.map(s => ({ sede_id: s.id, nome: s.nome, attiva: s.attiva !== false, modello: s.modello_compensi || 'nessuno' })),
    medici: [], coppie: [], regole: [], righe: []
  };
  if (!centri.length) return res.status(200).json(vuoto);

  const inCentri = centri.map(c => `"${c.id}"`).join(',');
  const [regRes, liqRes, appRes, preRes] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/coop_regole_compensi?cooperativa_id=eq.${encodeURIComponent(coopId)}&select=medico_id,sede_id,tipo,valore`, { headers: srvHeaders }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/coop_compensi_liquidati?cooperativa_id=eq.${encodeURIComponent(coopId)}&anno=eq.${anno}&mese=eq.${mese}&select=medico_id,sede_id,importo`, { headers: srvHeaders }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/appuntamenti?centro_id=in.(${inCentri})&erogata=is.true&or=(cancelled.is.null,cancelled.eq.false)&data=gte.${dal}&data=lte.${al}&select=tipo_visita,medico_id,centro_id,data`, { headers: srvHeaders }).catch(() => null),
    fetch(`${supabaseUrl}/rest/v1/prestazioni_centro?centro_id=in.(${inCentri})&select=centro_id,tipo_visita,prezzo,compenso,tipo,valido_dal`, { headers: srvHeaders }).catch(() => null)
  ]);
  if (!appRes || !appRes.ok) return res.status(500).json({ error: 'Lettura visite non riuscita' });
  if (!preRes || !preRes.ok) return res.status(500).json({ error: 'Lettura listini non riuscita' });

  const regole = (regRes && regRes.ok) ? (await regRes.json().catch(() => [])) : [];
  const liquidati = (liqRes && liqRes.ok) ? (await liqRes.json().catch(() => [])) : [];
  const visite = await appRes.json().catch(() => []);
  const listino = await preRes.json().catch(() => []);

  // listino per centro+tipo_visita (replica di _tariffaVigente del rendiconto medico)
  const listinoPerChiave = new Map();
  for (const p of (Array.isArray(listino) ? listino : [])) {
    const k = `${String(p.centro_id).toLowerCase()}|${String(p.tipo_visita || '').trim().toLowerCase()}`;
    if (!listinoPerChiave.has(k)) listinoPerChiave.set(k, []);
    listinoPerChiave.get(k).push(p);
  }
  function tariffaVigenteRow(centroId, tipoVisita, data) {
    const cands = (listinoPerChiave.get(`${String(centroId).toLowerCase()}|${String(tipoVisita || '').trim().toLowerCase()}`) || [])
      .filter(p => (p.valido_dal || '') <= (data || ''));
    if (!cands.length) return null;
    cands.sort((x, y) => (y.valido_dal || '').localeCompare(x.valido_dal || ''));
    return cands[0];
  }

  const regolaPerChiave = new Map();
  for (const r of (Array.isArray(regole) ? regole : [])) {
    regolaPerChiave.set(`${String(r.sede_id).toLowerCase()}|${String(r.medico_id).toLowerCase()}`, { tipo: r.tipo, valore: Number(r.valore) });
  }
  const liquidatoPerChiave = new Map();
  for (const l of (Array.isArray(liquidati) ? liquidati : [])) {
    liquidatoPerChiave.set(`${String(l.sede_id).toLowerCase()}|${String(l.medico_id).toLowerCase()}`, Number(l.importo));
  }
  const sedeDiCentro = new Map(centri.map(c => [String(c.id).toLowerCase(), c.coop_sede_id ? String(c.coop_sede_id).toLowerCase() : null]));

  // aggregazione per sede×medico (solo sedi con modello ≠ nessuno)
  const agg = new Map(); // sede|medico → { visite, mancantiComp, mancantiPrezzo, baseComp, basePrezzo, fissoN }
  const AGG0 = () => ({ visite: 0, mancantiComp: 0, mancantiPrezzo: 0, baseComp: 0, basePrezzo: 0, fissoN: 0 });
  function aggDi(k) {
    if (!agg.has(k)) agg.set(k, AGG0());
    return agg.get(k);
  }
  for (const v of (Array.isArray(visite) ? visite : [])) {
    const m = v.medico_id ? String(v.medico_id).toLowerCase() : '';
    if (!m) continue;
    const sedeId = sedeDiCentro.get(String(v.centro_id).toLowerCase());
    if (!sedeId) continue;
    const modello = modelloDiSede.get(sedeId) || 'nessuno';
    if (modello === 'nessuno') continue;
    const a = aggDi(`${sedeId}|${m}`);
    a.visite += 1;
    a.fissoN += 1;
    const tar = tariffaVigenteRow(v.centro_id, v.tipo_visita, v.data);
    let comp = null, prezzo = null;
    if (tar) {
      if (tar.tipo === 'percentuale') comp = (tar.prezzo == null) ? null : (Number(tar.compenso) / 100) * Number(tar.prezzo);
      else comp = (tar.compenso == null) ? null : Number(tar.compenso);
      prezzo = (tar.prezzo == null) ? null : Number(tar.prezzo);
    }
    if (comp == null || !Number.isFinite(comp)) a.mancantiComp += 1;
    else a.baseComp += comp;
    if (prezzo == null || !Number.isFinite(prezzo)) a.mancantiPrezzo += 1;
    else a.basePrezzo += prezzo;
  }

  // righe: una per coppia sede×medico sulle sedi con modello ≠ nessuno
  const righe = [];
  for (const chiave of coppie) {
    const [sedeId, medicoId] = chiave.split('|');
    const modello = modelloDiSede.get(sedeId) || 'nessuno';
    if (modello === 'nessuno') continue;
    const a = agg.get(chiave) || AGG0();
    const regola = regolaPerChiave.get(chiave) || null;
    let importo = null, senzaTariffa;
    if (modello === 'centro_paga') {
      importo = round2(a.baseComp);
      senzaTariffa = a.mancantiComp;
    } else {
      senzaTariffa = a.mancantiPrezzo;
      if (regola) {
        if (regola.tipo === 'percentuale') importo = round2(a.basePrezzo * regola.valore / 100);
        else if (regola.tipo === 'mensile') importo = round2(regola.valore);
        else importo = round2(a.fissoN * regola.valore);
      }
    }
    righe.push({
      sede_id: sedeId,
      medico_id: medicoId,
      verso: modello,
      visite: a.visite,
      senza_tariffa: senzaTariffa,
      importo,
      regola,
      liquidato: liquidatoPerChiave.has(chiave) ? liquidatoPerChiave.get(chiave) : null
    });
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
  const nomeDiSede = new Map(sedi.map(s => [String(s.id).toLowerCase(), s.nome || 'Sede']));
  righe.sort((a, b) =>
    (nomeDiSede.get(a.sede_id) || '').localeCompare(nomeDiSede.get(b.sede_id) || '') ||
    (medNomi.get(a.medico_id) || '').localeCompare(medNomi.get(b.medico_id) || '')
  );

  return res.status(200).json({
    anno, mese,
    sedi: sedi.map(s => ({ sede_id: s.id, nome: s.nome, attiva: s.attiva !== false, modello: s.modello_compensi || 'nessuno' })),
    medici: [...mediciCoop].map(id => ({ medico_id: id, nome: medNomi.get(id) || 'Medico' }))
      .sort((a, b) => a.nome.localeCompare(b.nome)),
    coppie: [...coppie].map(k => { const [s, m] = k.split('|'); return { sede_id: s, medico_id: m }; }),
    regole: (Array.isArray(regole) ? regole : []).map(r => ({ medico_id: String(r.medico_id).toLowerCase(), sede_id: String(r.sede_id).toLowerCase(), tipo: r.tipo, valore: Number(r.valore) })),
    righe
  });
}
