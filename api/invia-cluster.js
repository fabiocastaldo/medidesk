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
// POST { action:'leggi_consenso',  token }                [pubblica, solo revoca]
// POST { action:'revoca_consenso', token }                [pubblica]
// POST { action:'anteprima', criteri }                    [JWT medico + modulo]
// POST { action:'invia', criteri, corpo, cluster_id? }    [JWT medico + modulo]

import { Resend } from 'resend';
import { randomBytes, createHash } from 'crypto';
import { emailShell, emailTitle, noteBox, ctaButton, esc } from '../lib/email-shell.js';
import { CONS_COMM_VERSIONE, readPayload, revocaLink } from '../lib/consenso-token.js';

const MAX_CORPO = 4000;
const MAX_DESTINATARI = 200;

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
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
  // Il consenso si PRESTA solo in fase di prenotazione online personale: qui vive
  // soltanto la revoca (e la sua pagina), che deve funzionare sempre.
  if (action === 'leggi_consenso' || action === 'revoca_consenso') {
    const payload = readPayload(serviceKey, body.token);
    if (!payload || payload.a !== 'r' || (!payload.p && !(payload.e && payload.m))) {
      return res.status(401).json({ error: 'link_non_valido' });
    }
    let medicoNome = 'Il suo medico', medicoId = null, emailPaz = null, pazIds = [], attivo = false;
    if (payload.p) {
      const pr = await sb(`pazienti?id=eq.${encodeURIComponent(payload.p)}&select=id,email,medico_id,consenso_comunicazioni_at,medici(titolo,nome,cognome)`);
      const paz = pr.ok ? (await pr.json())[0] : null;
      if (!paz) return res.status(404).json({ error: 'not_found' });
      medicoId = paz.medico_id; emailPaz = paz.email; pazIds = [paz.id];
      attivo = !!paz.consenso_comunicazioni_at;
      if (paz.medici) medicoNome = [paz.medici.titolo, paz.medici.nome, paz.medici.cognome].filter(Boolean).join(' ');
    } else {
      medicoId = payload.m; emailPaz = payload.e;
      const mr = await sb(`medici?id=eq.${encodeURIComponent(medicoId)}&select=titolo,nome,cognome`);
      const med = mr.ok ? (await mr.json())[0] : null;
      if (!med) return res.status(404).json({ error: 'not_found' });
      medicoNome = [med.titolo, med.nome, med.cognome].filter(Boolean).join(' ');
      const pz = await sb(`pazienti?medico_id=eq.${encodeURIComponent(medicoId)}&email=ilike.${encodeURIComponent(emailPaz)}&select=id,consenso_comunicazioni_at`);
      const rowsPz = pz.ok ? await pz.json() : [];
      pazIds = rowsPz.map(x => x.id);
      const ap = await sb(`appuntamenti?medico_id=eq.${encodeURIComponent(medicoId)}&email_paziente=ilike.${encodeURIComponent(emailPaz)}&consenso_comunicazioni_at=not.is.null&select=id&limit=1`);
      const rowsAp = ap.ok ? await ap.json() : [];
      attivo = rowsPz.some(x => x.consenso_comunicazioni_at) || rowsAp.length > 0;
    }
    if (action === 'leggi_consenso') {
      return res.status(200).json({ medico: medicoNome, stato: attivo ? 'attivo' : 'revocato', azione: 'revoca' });
    }
    const now = new Date().toISOString();
    // La revoca azzera il fascicolo (se esiste) E le tracce sulle prenotazioni,
    // cosi' il trigger di ereditarieta' non potra' mai resuscitare un consenso revocato.
    if (pazIds.length) {
      const ur = await sb(`pazienti?id=in.(${pazIds.map(encodeURIComponent).join(',')})`, {
        method: 'PATCH', headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ consenso_comunicazioni_at: null, consenso_comunicazioni_versione: null, consenso_comunicazioni_revocato_at: now })
      });
      if (!ur.ok) return res.status(500).json({ error: 'db' });
    }
    if (emailPaz && medicoId) {
      await sb(`appuntamenti?medico_id=eq.${encodeURIComponent(medicoId)}&email_paziente=ilike.${encodeURIComponent(emailPaz)}&consenso_comunicazioni_at=not.is.null`, {
        method: 'PATCH',
        body: JSON.stringify({ consenso_comunicazioni_at: null, consenso_comunicazioni_versione: null })
      }).catch(() => {});
    }
    return res.status(200).json({ ok: true, medico: medicoNome, quando: now });
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

        const linkMsg = `https://${host}/t/${tokenThread}`;
        const linkRevoca = revocaLink(host, serviceKey, { pazienteId: p.id });
        const corpoMail =
          emailTitle('Una comunicazione dal suo medico') +
          `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 12px;">${esc(medicoNome)} le ha inviato una comunicazione.</p>` +
          `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 20px;">Per leggerla e, se vuole, rispondere apra il link qui sotto.</p>` +
          ctaButton(linkMsg, 'Apri la comunicazione') +
          `<p style="font-size:12px;color:#888;line-height:1.6;margin:0 0 20px;">Se il pulsante non funziona, copi questo indirizzo nel browser:<br>${esc(linkMsg)}</p>` +
          noteBox('Questo canale non &egrave; adatto alle urgenze: in caso di emergenza contatti il <strong>112</strong> o si rechi al pronto soccorso. Il link &egrave; personale: non lo inoltri ad altri.') +
          `<p style="font-size:12px;color:#888;line-height:1.6;margin:0;">Riceve questa email perch&eacute; ha dato il consenso alle comunicazioni proattive del suo medico.</p>`;
        const { error } = await resend.emails.send({
          from: 'noreply@delphi-med.com', to: [p.email],
          subject: `Comunicazione da ${medicoNome} — Delphi~Med`,
          html: emailShell(corpoMail, { footerNote: `Non desidera pi&ugrave; ricevere queste comunicazioni? <a href="${esc(linkRevoca)}" style="color:#888;">Revochi qui il consenso</a> &middot; Delphi~Med` })
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
