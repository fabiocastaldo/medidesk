// api/invia-cluster.js
// Comunicazioni proattive (modulo 'comunicazioni', s20).
// Consenso double opt-in: il medico RICHIEDE, il paziente CONFERMA dalla propria
// casella email via link a token HMAC stateless (firmato con chiave server).
// La prova del consenso = possesso della casella + timestamp scritto dal server
// + versione del testo acconsentito (pazienti.consenso_comunicazioni_*).
// Invio massivo: criteri risolti SOLO lato server, destinatari = pazienti del
// medico con email E consenso attivo. La comunicazione e' UNA SEMPLICE EMAIL col
// testo nel corpo, da consultare: NESSUN thread, nessun canale di risposta (il
// one-to-one resta a msg-thread per il dialogo clinico). Percio' il testo viaggia
// in chiaro: mai contenuti clinici o riferiti al singolo. Resta la riga di 'invii'
// (criteri_snapshot + n_destinatari = registro del titolare) e in calce a ogni
// email il link di revoca; conferma e revoca NON sono gated dal modulo.
//
// POST { action:'leggi_consenso',    token }              [pubblica]
// POST { action:'conferma_consenso', token }              [pubblica, solo token 'c' da mail di richiesta]
// POST { action:'revoca_consenso',   token }              [pubblica, solo token 'r']
// POST { action:'anteprima', criteri }                    [JWT medico + modulo]
// POST { action:'invia', criteri, corpo, cluster_id? }    [JWT medico + modulo]

import { Resend } from 'resend';
import { emailShell, emailTitle, noteBox, ctaButton, esc } from '../lib/email-shell.js';
import { CONS_COMM_VERSIONE, readPayload, revocaLink } from '../lib/consenso-token.js';

const MAX_CORPO = 4000;
const MAX_DESTINATARI = 200;


async function checkMedicoAuth(jwt, supabaseUrl, anonKey, serviceKey) {
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': anonKey }
  }).catch(() => null);
  if (!userRes || !userRes.ok) return { ok: false, status: 401, error: 'Token non valido o scaduto' };
  const userData = await userRes.json().catch(() => null);
  if (!userData?.id) return { ok: false, status: 401, error: 'Utente non riconosciuto' };
  const medicoRes = await fetch(
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&stato=eq.approvato&deleted_at=is.null&select=id,titolo,nome,cognome,moduli,slug`,
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
  // tipi_visita (motivo della visita, multiselezione dal catalogo); tipo_visita stringa = legacy dei cluster salvati
  const tipi = Array.isArray(c.tipi_visita) ? c.tipi_visita
    : (typeof c.tipo_visita === 'string' && c.tipo_visita.trim() ? [c.tipo_visita] : null);
  if (tipi) {
    const puliti = tipi.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().slice(0, 120)).slice(0, 100);
    if (puliti.length) out.tipi_visita = puliti;
  }
  if (Array.isArray(c.aree)) {
    const puliti = c.aree.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim().slice(0, 120)).slice(0, 100);
    if (puliti.length) out.aree = puliti;
  }
  const isData = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (isData(c.prenotati_dal)) out.prenotati_dal = c.prenotati_dal;
  if (isData(c.prenotati_al)) out.prenotati_al = c.prenotati_al;
  return out;
}

async function resolveDestinatari(sb, medicoId, criteri) {
  const pr = await sb(`pazienti?medico_id=eq.${medicoId}&email=not.is.null&select=id,nome,cognome,email,data_nascita,consenso_comunicazioni_at&order=cognome.asc`);
  if (!pr.ok) throw new Error('pazienti_query ' + pr.status);
  const fascicoli = await pr.json();
  // Se esiste un fascicolo con quella email, decide il fascicolo (create-booking e il trigger
  // gli portano il consenso, la revoca lo azzera). Senza fascicolo, vale il consenso dato
  // prenotando: il paziente lo ha prestato a questo medico, il fascicolo e' solo un contenitore.
  const conFascicolo = new Set(fascicoli.map(p => String(p.email || '').trim().toLowerCase()));
  let paz = fascicoli.filter(p => p.consenso_comunicazioni_at)
    .map(p => ({ id: p.id, nome: p.nome, cognome: p.cognome, email: p.email, data_nascita: p.data_nascita }));
  const cr = await sb(`appuntamenti?medico_id=eq.${medicoId}&email_paziente=not.is.null&consenso_comunicazioni_at=not.is.null&select=nome_paziente,cognome_paziente,email_paziente,consenso_comunicazioni_at`);
  if (!cr.ok) throw new Error('consensi_prenotazione_query ' + cr.status);
  const perEmailPren = new Map();
  for (const a of await cr.json()) {
    const k = String(a.email_paziente || '').trim().toLowerCase();
    if (!k || conFascicolo.has(k)) continue;
    const prev = perEmailPren.get(k);
    if (!prev || a.consenso_comunicazioni_at > prev.consenso_comunicazioni_at) perEmailPren.set(k, a);
  }
  for (const a of perEmailPren.values()) {
    // Niente data di nascita senza fascicolo: un filtro per eta' li esclude, come i fascicoli senza data.
    paz.push({ id: null, nome: a.nome_paziente || '', cognome: a.cognome_paziente || '', email: a.email_paziente, data_nascita: null, da_prenotazione: true });
  }
  paz.sort((x, y) => String(x.cognome || '').localeCompare(String(y.cognome || ''), 'it'));

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

  if (paz.length && (criteri.tipi_visita || criteri.aree || criteri.prenotati_dal || criteri.prenotati_al)) {
    // Aggancio appuntamento->fascicolo per EMAIL (lowercase): paziente_id non viene
    // popolato da nessun flusso reale, l'email del paziente invece viaggia sempre.
    const ar = await sb(`appuntamenti?medico_id=eq.${medicoId}&email_paziente=not.is.null&cancelled=not.is.true&select=email_paziente,data,tipo_visita,area_tematica`);
    if (!ar.ok) throw new Error('appuntamenti_query ' + ar.status);
    const apps = await ar.json();
    const perPaz = new Map();
    for (const a of apps) {
      const k = String(a.email_paziente || '').trim().toLowerCase();
      if (!k) continue;
      if (!perPaz.has(k)) perPaz.set(k, []);
      perPaz.get(k).push(a);
    }
    paz = paz.filter(p => {
      const mie = perPaz.get(String(p.email || '').trim().toLowerCase()) || [];
      if (criteri.tipi_visita && !mie.some(a => criteri.tipi_visita.includes(a.tipo_visita))) return false;
      if (criteri.aree && !mie.some(a => a.area_tematica && criteri.aree.includes(a.area_tematica))) return false;
      if ((criteri.prenotati_dal || criteri.prenotati_al) && !mie.some(a => {
        const d = String(a.data || '');
        if (!d) return false;
        if (criteri.prenotati_dal && d < criteri.prenotati_dal) return false;
        if (criteri.prenotati_al && d > criteri.prenotati_al) return false;
        return true;
      })) return false;
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
  if (action === 'leggi_consenso' || action === 'conferma_consenso' || action === 'revoca_consenso') {
    const payload = readPayload(serviceKey, body.token);
    const okR = payload && payload.a === 'r' && (payload.p || (payload.e && payload.m));
    const okC = payload && payload.a === 'c' && (payload.ap || payload.p);
    if (!okR && !okC) return res.status(401).json({ error: 'link_non_valido' });
    if (action === 'conferma_consenso' && !okC) return res.status(401).json({ error: 'link_non_valido' });
    if (action === 'revoca_consenso' && !okR) return res.status(401).json({ error: 'link_non_valido' });

    // Token 'c': richiesta di consenso ancorata a una prenotazione (payload.ap)
    // o a un fascicolo creato a mano (payload.p).
    if (okC) {
      let appt = null, medRow = null, emailC = null, medicoIdC = null;
      if (payload.ap) {
        const ar = await sb(`appuntamenti?id=eq.${encodeURIComponent(payload.ap)}&select=id,medico_id,email_paziente,consenso_comunicazioni_at,medici(titolo,nome,cognome)`);
        appt = ar.ok ? (await ar.json())[0] : null;
        if (!appt || !appt.email_paziente) return res.status(404).json({ error: 'not_found' });
        medRow = appt.medici; emailC = appt.email_paziente; medicoIdC = appt.medico_id;
      } else {
        const fr = await sb(`pazienti?id=eq.${encodeURIComponent(payload.p)}&select=id,medico_id,email,consenso_comunicazioni_at,consenso_comunicazioni_revocato_at,medici(titolo,nome,cognome)`);
        const fas = fr.ok ? (await fr.json())[0] : null;
        if (!fas || !fas.email) return res.status(404).json({ error: 'not_found' });
        medRow = fas.medici; emailC = fas.email; medicoIdC = fas.medico_id;
      }
      const medNome = medRow ? [medRow.titolo, medRow.nome, medRow.cognome].filter(Boolean).join(' ') : 'Il suo medico';
      const pz = await sb(`pazienti?medico_id=eq.${encodeURIComponent(medicoIdC)}&email=ilike.${encodeURIComponent(emailC)}&select=id,consenso_comunicazioni_at,consenso_comunicazioni_revocato_at`);
      const rowsPz = pz.ok ? await pz.json() : [];
      const cAttivo = !!(appt && appt.consenso_comunicazioni_at) || rowsPz.some(x => x.consenso_comunicazioni_at);
      if (action === 'leggi_consenso') {
        const stato = cAttivo ? 'attivo' : (rowsPz.some(x => x.consenso_comunicazioni_revocato_at) ? 'revocato' : 'nessuno');
        return res.status(200).json({ medico: medNome, stato, azione: 'consenso', versione: payload.v || CONS_COMM_VERSIONE });
      }
      // conferma_consenso: timestamp server sull'ancora (appuntamento o fascicolo)
      // e su tutti i fascicoli con quella email (il consenso e' della casella).
      const nowC = new Date().toISOString();
      if (appt) {
        const ur = await sb(`appuntamenti?id=eq.${appt.id}`, {
          method: 'PATCH', headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify({ consenso_comunicazioni_at: nowC, consenso_comunicazioni_versione: payload.v || CONS_COMM_VERSIONE })
        });
        const urRows = ur.ok ? await ur.json() : [];
        if (!urRows[0]) return res.status(500).json({ error: 'db' });
      }
      const up = await sb(`pazienti?medico_id=eq.${encodeURIComponent(medicoIdC)}&email=ilike.${encodeURIComponent(emailC)}`, {
        method: 'PATCH', headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ consenso_comunicazioni_at: nowC, consenso_comunicazioni_versione: payload.v || CONS_COMM_VERSIONE, consenso_comunicazioni_revocato_at: null })
      });
      const upRows = up.ok ? await up.json() : [];
      if (!appt && !upRows[0]) return res.status(500).json({ error: 'db' });
      return res.status(200).json({ ok: true, medico: medNome, quando: nowC, versione: payload.v || CONS_COMM_VERSIONE });
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

    let inviati = 0;
    const falliti = [];
    const linkPrenota = medico.slug ? `https://delphi-med.com/?booking&doc=${encodeURIComponent(medico.slug)}` : '';
    for (const p of dest) {
      try {
        const linkRevoca = p.id
          ? revocaLink(host, serviceKey, { pazienteId: p.id })
          : revocaLink(host, serviceKey, { email: p.email, medicoId: medico.id });
        const corpoHtml = esc(corpo).replace(/\r?\n/g, '<br>');
        const corpoMail =
          emailTitle(`Una comunicazione da ${esc(medicoNome)}`) +
          `<div style="font-size:14px;color:#333;line-height:1.7;margin:0 0 20px;padding:14px 16px;background:#F7F9F8;border:1px solid #E7ECEA;border-radius:10px;">${corpoHtml}</div>` +
          (linkPrenota ? ctaButton(linkPrenota, 'Prenota online') : '') +
          `<p style="font-size:12px;color:#888;line-height:1.6;margin:0;">Questa email &egrave; solo informativa e non prevede risposta. La ricevi perch&eacute; hai dato il consenso alle comunicazioni proattive del tuo medico.</p>`;
        const { error } = await resend.emails.send({
          from: 'noreply@delphi-med.com', to: [p.email],
          subject: `Comunicazione da ${medicoNome} — Delphi~Med`,
          html: emailShell(corpoMail, { footerNote: `Non desideri pi&ugrave; ricevere queste comunicazioni? <a href="${esc(linkRevoca)}" style="color:#888;">Revoca qui il consenso</a> &middot; Delphi~Med` })
        });
        if (error) throw new Error('resend ' + (error.message || 'errore'));
        inviati++;
      } catch (e) {
        console.error('[invia-cluster] destinatario fallito:', p.id, e.message);
        falliti.push({ id: p.id, nome: p.nome, cognome: p.cognome });
      }
    }
    return res.status(200).json({ invio_id: invio.id, inviati, falliti });
  }

  return res.status(400).json({ error: 'action_non_valida' });
}
