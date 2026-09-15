// api/invia-cluster.js
// Comunicazioni proattive (modulo 'comunicazioni', s20).
// Consenso double opt-in: il medico RICHIEDE, il paziente CONFERMA dalla propria
// casella email via link a token HMAC stateless (firmato con chiave server).
// La prova del consenso = possesso della casella + timestamp scritto dal server
// + versione del testo acconsentito (pazienti.consenso_comunicazioni_*).
// Invio massivo: criteri risolti SOLO lato server, destinatari = pazienti del
// medico con email E consenso attivo; ogni destinatario riceve un thread
// origine='cluster' agganciato a una riga di 'invii' (criteri_snapshot +
// n_destinatari = registro del titolare). In calce a ogni email di cluster il
// link di revoca; conferma e revoca NON sono gated dal modulo.
//
// POST { action:'richiedi_consenso', paziente_id }        [JWT medico + modulo]
// POST { action:'leggi_consenso',    token }              [pubblica]
// POST { action:'conferma_consenso', token }              [pubblica]
// POST { action:'revoca_consenso',   token }              [pubblica]
// POST { action:'anteprima', criteri }                    [JWT medico + modulo]
// POST { action:'invia', criteri, corpo, cluster_id? }    [JWT medico + modulo]

import { Resend } from 'resend';
import { createHmac, randomBytes, createHash, timingSafeEqual } from 'crypto';

const CONS_COMM_VERSIONE = 'cons-comm-0.1-bozza'; // segnaposto: testo definitivo dal corpus legale (gate C)
const MAX_CORPO = 4000;
const MAX_DESTINATARI = 200;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function signPayload(secret, payloadObj) {
  const body = b64url(JSON.stringify(payloadObj));
  const sig = createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
  return body + '.' + sig;
}
function readPayload(secret, token) {
  if (typeof token !== 'string' || token.length > 600) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = createHmac('sha256', secret).update(parts[0], 'utf8').digest();
  let given;
  try { given = Buffer.from(parts[1], 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (!Number.isFinite(payload.exp) || Date.now() > payload.exp) return null;
  return payload;
}

async function checkMedicoAuth(jwt, supabaseUrl, anonKey, serviceKey) {
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': anonKey }
  }).catch(() => null);
  if (!userRes || !userRes.ok) return { ok: false, status: 401, error: 'Token non valido o scaduto' };
  const userData = await userRes.json().catch(() => null);
  if (!userData?.id) return { ok: false, status: 401, error: 'Utente non riconosciuto' };
  const medicoRes = await fetch(
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&stato=eq.approvato&deleted_at=is.null&select=id,titolo,nome,cognome,moduli,msg_durata_giorni,msg_tempi_risposta`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  ).catch(() => null);
  if (!medicoRes || !medicoRes.ok) return { ok: false, status: 403, error: 'Verifica account fallita' };
  const rows = await medicoRes.json().catch(() => []);
  if (!rows?.[0]) return { ok: false, status: 403, error: 'Account non autorizzato' };
  return { ok: true, medico: rows[0] };
}

function mailShell(inner) {
  return `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a">
  <div style="font-size:18px;font-weight:700;margin-bottom:12px">Delphi~Med</div>
  ${inner}
</div>`;
}
function bottone(link, label) {
  return `<div style="margin:22px 0"><a href="${esc(link)}" style="display:inline-block;background:#0D5C8C;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${esc(label)}</a></div>
  <div style="font-size:13px;color:#555;line-height:1.5">Se il pulsante non funziona, copi questo indirizzo nel browser:<br>${esc(link)}</div>`;
}

function calcolaEta(dataNascita, oggi) {
  const dn = new Date(dataNascita + 'T00:00:00');
  if (isNaN(dn)) return null;
  let eta = oggi.getFullYear() - dn.getFullYear();
  const m = oggi.getMonth() - dn.getMonth();
  if (m < 0 || (m === 0 && oggi.getDate() < dn.getDate())) eta--;
  return eta;
}

function pulisciCriteri(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  if (Number.isInteger(c.eta_min) && c.eta_min >= 0 && c.eta_min <= 130) out.eta_min = c.eta_min;
  if (Number.isInteger(c.eta_max) && c.eta_max >= 0 && c.eta_max <= 130) out.eta_max = c.eta_max;
  if (Number.isInteger(c.ultima_visita_oltre_giorni) && c.ultima_visita_oltre_giorni > 0 && c.ultima_visita_oltre_giorni <= 3650) out.ultima_visita_oltre_giorni = c.ultima_visita_oltre_giorni;
  if (typeof c.tipo_visita === 'string' && c.tipo_visita.trim()) out.tipo_visita = c.tipo_visita.trim().slice(0, 120);
  if (c.categoria === 'prima_visita' || c.categoria === 'controllo') out.categoria = c.categoria;
  return out;
}

async function resolveDestinatari(sb, medicoId, criteri) {
  const pr = await sb(`pazienti?medico_id=eq.${medicoId}&email=not.is.null&consenso_comunicazioni_at=not.is.null&select=id,nome,cognome,email,data_nascita&order=cognome.asc`);
  if (!pr.ok) throw new Error('pazienti_query ' + pr.status);
  let paz = await pr.json();

  const oggi = new Date();
  if (criteri.eta_min != null || criteri.eta_max != null) {
    paz = paz.filter(p => {
      if (!p.data_nascita) return false;
      const eta = calcolaEta(p.data_nascita, oggi);
      if (eta == null) return false;
      if (criteri.eta_min != null && eta < criteri.eta_min) return false;
      if (criteri.eta_max != null && eta > criteri.eta_max) return false;
      return true;
    });
  }

  if (paz.length && (criteri.tipo_visita || criteri.categoria || criteri.ultima_visita_oltre_giorni)) {
    const ar = await sb(`appuntamenti?medico_id=eq.${medicoId}&paziente_id=not.is.null&cancelled=not.is.true&select=paziente_id,data,tipo_visita,categoria`);
    if (!ar.ok) throw new Error('appuntamenti_query ' + ar.status);
    const apps = await ar.json();
    const perPaz = new Map();
    for (const a of apps) {
      const k = String(a.paziente_id);
      if (!perPaz.has(k)) perPaz.set(k, []);
      perPaz.get(k).push(a);
    }
    const soglia = criteri.ultima_visita_oltre_giorni
      ? new Date(Date.now() - criteri.ultima_visita_oltre_giorni * 86400000).toISOString().slice(0, 10)
      : null;
    paz = paz.filter(p => {
      const mie = perPaz.get(String(p.id)) || [];
      if (criteri.tipo_visita && !mie.some(a => a.tipo_visita === criteri.tipo_visita)) return false;
      if (criteri.categoria && !mie.some(a => a.categoria === criteri.categoria)) return false;
      if (soglia && mie.some(a => String(a.data) >= soglia)) return false;
      return true;
    });
  }
  return paz;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl  = process.env.SUPABASE_URL;
  const serviceKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey      = process.env.SUPABASE_ANON_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey || !resendApiKey) {
    console.error('[invia-cluster] env vars mancanti');
    return res.status(500).json({ error: 'Configurazione server mancante' });
  }

  const base = `${supabaseUrl}/rest/v1`;
  const dbHeaders = { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const sb = (path, opts = {}) => fetch(`${base}/${path}`, { ...opts, headers: { ...dbHeaders, ...(opts.headers || {}) } });
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'delphi-med.com').split(',')[0].trim();
  const resend = new Resend(resendApiKey);

  const body = req.body || {};
  const action = body.action;

  // ── Azioni pubbliche (token del paziente, nessun JWT, nessun gate modulo) ──
  if (action === 'leggi_consenso' || action === 'conferma_consenso' || action === 'revoca_consenso') {
    const payload = readPayload(serviceKey, body.token);
    if (!payload || !payload.p || (payload.a !== 'c' && payload.a !== 'r')) {
      return res.status(401).json({ error: 'link_non_valido' });
    }
    const pr = await sb(`pazienti?id=eq.${encodeURIComponent(payload.p)}&select=id,medico_id,consenso_comunicazioni_at,consenso_comunicazioni_revocato_at,medici(titolo,nome,cognome)`);
    const paz = pr.ok ? (await pr.json())[0] : null;
    if (!paz) return res.status(404).json({ error: 'not_found' });
    const medicoNome = paz.medici ? [paz.medici.titolo, paz.medici.nome, paz.medici.cognome].filter(Boolean).join(' ') : 'Il suo medico';

    if (action === 'leggi_consenso') {
      const stato = paz.consenso_comunicazioni_at ? 'attivo' : (paz.consenso_comunicazioni_revocato_at ? 'revocato' : 'nessuno');
      return res.status(200).json({ medico: medicoNome, stato, azione: payload.a === 'c' ? 'consenso' : 'revoca', versione: payload.v || CONS_COMM_VERSIONE });
    }
    if (action === 'conferma_consenso') {
      if (payload.a !== 'c') return res.status(401).json({ error: 'link_non_valido' });
      const ur = await sb(`pazienti?id=eq.${paz.id}`, {
        method: 'PATCH', headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({
          consenso_comunicazioni_at: new Date().toISOString(),
          consenso_comunicazioni_versione: payload.v || CONS_COMM_VERSIONE,
          consenso_comunicazioni_revocato_at: null
        })
      });
      const rows = ur.ok ? await ur.json() : [];
      if (!rows[0]) return res.status(500).json({ error: 'db' });
      return res.status(200).json({ ok: true, medico: medicoNome, quando: rows[0].consenso_comunicazioni_at, versione: rows[0].consenso_comunicazioni_versione });
    }
    // revoca_consenso: valido sia dal link di revoca (a='r') sia da un link consenso (ci ha ripensato: a='c')
    const ur = await sb(`pazienti?id=eq.${paz.id}`, {
      method: 'PATCH', headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        consenso_comunicazioni_at: null,
        consenso_comunicazioni_versione: null,
        consenso_comunicazioni_revocato_at: new Date().toISOString()
      })
    });
    const rows = ur.ok ? await ur.json() : [];
    if (!rows[0]) return res.status(500).json({ error: 'db' });
    return res.status(200).json({ ok: true, medico: medicoNome, quando: rows[0].consenso_comunicazioni_revocato_at });
  }

  // ── Azioni del medico: JWT + gate modulo 'comunicazioni' ──────────────────
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Autenticazione richiesta' });
  const auth = await checkMedicoAuth(authHeader.slice(7), supabaseUrl, anonKey, serviceKey);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const medico = auth.medico;
  const medicoNome = [medico.titolo, medico.nome, medico.cognome].filter(Boolean).join(' ');
  if (!(medico.moduli && medico.moduli.comunicazioni === true)) {
    return res.status(403).json({ error: 'modulo_non_attivo' });
  }

  // ── richiedi_consenso ──────────────────────────────────────────────────────
  if (action === 'richiedi_consenso') {
    if (!body.paziente_id) return res.status(400).json({ error: 'parametri_mancanti' });
    const pr = await sb(`pazienti?id=eq.${encodeURIComponent(body.paziente_id)}&medico_id=eq.${medico.id}&select=id,nome,cognome,email`);
    const p = pr.ok ? (await pr.json())[0] : null;
    if (!p) return res.status(404).json({ error: 'not_found' });
    if (!p.email) return res.status(409).json({ error: 'email_mancante' });

    const token = signPayload(serviceKey, { p: p.id, a: 'c', v: CONS_COMM_VERSIONE, exp: Date.now() + 30 * 86400000 });
    const link = `https://${host}/?consenso=${encodeURIComponent(token)}`;
    const inner = `
  <div style="font-size:15px;line-height:1.5">${esc(medicoNome)} le chiede il consenso a ricevere via email comunicazioni proattive (promemoria di prevenzione, richiami, avvisi organizzativi).</div>
  <div style="font-size:15px;line-height:1.5;margin-top:10px">Il consenso &egrave; facoltativo e revocabile in ogni momento. Apra il link per leggere l'informativa e decidere.</div>
  ${bottone(link, 'Leggi e decidi')}
  <div style="font-size:12px;color:#888;margin-top:22px;line-height:1.5">Se non desidera acconsentire pu&ograve; semplicemente ignorare questa email. Il link &egrave; personale: non lo inoltri ad altri.</div>`;
    const { error } = await resend.emails.send({
      from: 'noreply@delphi-med.com', to: [p.email],
      subject: `${medicoNome} le chiede un consenso — Delphi~Med`,
      html: mailShell(inner)
    });
    if (error) { console.error('[invia-cluster] richiedi resend:', error.message || error); return res.status(502).json({ error: 'email_fallita' }); }

    const ur = await sb(`pazienti?id=eq.${p.id}`, {
      method: 'PATCH', headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ consenso_comunicazioni_richiesto_at: new Date().toISOString() })
    });
    const rows = ur.ok ? await ur.json() : [];
    if (!rows[0]) return res.status(500).json({ error: 'db' });
    return res.status(200).json({ ok: true, richiesto_il: rows[0].consenso_comunicazioni_richiesto_at });
  }

  // ── anteprima ──────────────────────────────────────────────────────────────
  if (action === 'anteprima') {
    const criteri = pulisciCriteri(body.criteri);
    let dest;
    try { dest = await resolveDestinatari(sb, medico.id, criteri); }
    catch (e) { console.error('[invia-cluster] anteprima:', e.message); return res.status(500).json({ error: 'db' }); }
    return res.status(200).json({ n: dest.length, criteri, destinatari: dest.map(p => ({ id: p.id, nome: p.nome, cognome: p.cognome })) });
  }

  // ── invia ──────────────────────────────────────────────────────────────────
  if (action === 'invia') {
    const corpo = typeof body.corpo === 'string' ? body.corpo.trim() : '';
    if (!corpo) return res.status(400).json({ error: 'corpo_mancante' });
    if (corpo.length > MAX_CORPO) return res.status(400).json({ error: 'corpo_troppo_lungo' });
    const criteri = pulisciCriteri(body.criteri);

    let dest;
    try { dest = await resolveDestinatari(sb, medico.id, criteri); }
    catch (e) { console.error('[invia-cluster] invia resolve:', e.message); return res.status(500).json({ error: 'db' }); }
    if (!dest.length) return res.status(409).json({ error: 'nessun_destinatario' });
    if (dest.length > MAX_DESTINATARI) return res.status(413).json({ error: 'troppi_destinatari', n: dest.length, max: MAX_DESTINATARI });

    const ir = await sb('invii', {
      method: 'POST', headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        medico_id: medico.id,
        cluster_id: typeof body.cluster_id === 'string' && body.cluster_id ? body.cluster_id : null,
        criteri_snapshot: criteri,
        n_destinatari: dest.length
      })
    });
    if (!ir.ok) { console.error('[invia-cluster] invii insert', ir.status); return res.status(500).json({ error: 'db' }); }
    const invio = (await ir.json())[0];

    const durata = medico.msg_durata_giorni ?? 30;
    const scadeIl = durata > 0 ? new Date(Date.now() + durata * 86400000).toISOString() : null;
    const tokenExp = scadeIl || new Date(Date.now() + 365 * 86400000).toISOString();

    let inviati = 0;
    const falliti = [];
    for (const p of dest) {
      let thread = null;
      try {
        const tr = await sb('thread_messaggi', {
          method: 'POST', headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify({
            medico_id: medico.id, paziente_id: p.id, invio_id: invio.id,
            origine: 'cluster', recapito_email: p.email, scade_il: scadeIl
          })
        });
        if (!tr.ok) throw new Error('thread_insert ' + tr.status);
        thread = (await tr.json())[0];

        const mr = await sb('messaggi', { method: 'POST', body: JSON.stringify({ thread_id: thread.id, direzione: 'medico', corpo }) });
        if (!mr.ok) throw new Error('messaggio_insert ' + mr.status);

        const tokenThread = randomBytes(32).toString('base64url');
        const kr = await sb('token_thread', {
          method: 'POST',
          body: JSON.stringify({ token_hash: hashToken(tokenThread), thread_id: thread.id, expires_at: tokenExp })
        });
        if (!kr.ok) throw new Error('token_insert ' + kr.status);

        const revocaToken = signPayload(serviceKey, { p: p.id, a: 'r', exp: Date.now() + 365 * 86400000 });
        const linkMsg = `https://${host}/t/${tokenThread}`;
        const linkRevoca = `https://${host}/?revoca_comm=${encodeURIComponent(revocaToken)}`;
        const inner = `
  <div style="font-size:15px;line-height:1.5">${esc(medicoNome)} le ha inviato una comunicazione.</div>
  <div style="font-size:15px;line-height:1.5;margin-top:10px">Per leggerla e, se vuole, rispondere apra il link qui sotto.</div>
  ${bottone(linkMsg, 'Apri la comunicazione')}
  <div style="font-size:12px;color:#888;margin-top:22px;line-height:1.5">Questo canale non &egrave; adatto alle urgenze: in caso di emergenza contatti il 112 o si rechi al pronto soccorso. Il link &egrave; personale: non lo inoltri ad altri.</div>
  <div style="font-size:12px;color:#888;margin-top:10px;line-height:1.5">Riceve questa email perch&eacute; ha dato il consenso alle comunicazioni proattive. Non desidera pi&ugrave; riceverne? <a href="${esc(linkRevoca)}" style="color:#555">Revochi qui il consenso</a>.</div>`;
        const { error } = await resend.emails.send({
          from: 'noreply@delphi-med.com', to: [p.email],
          subject: `Comunicazione da ${medicoNome} — Delphi~Med`,
          html: mailShell(inner)
        });
        if (error) throw new Error('resend ' + (error.message || 'errore'));
        inviati++;
      } catch (e) {
        console.error('[invia-cluster] destinatario fallito:', p.id, e.message);
        if (thread?.id) await sb(`thread_messaggi?id=eq.${thread.id}`, { method: 'DELETE' }).catch(() => {});
        falliti.push({ id: p.id, nome: p.nome, cognome: p.cognome });
      }
    }
    return res.status(200).json({ invio_id: invio.id, inviati, falliti });
  }

  return res.status(400).json({ error: 'action_non_valida' });
}
