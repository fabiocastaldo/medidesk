// api/msg-thread.js
// Messaggistica medico → paziente senza login (v1, s11).
// Il medico (JWT Supabase) apre un thread verso un paziente, scrive o chiude.
// Il paziente riceve una email NEUTRA (nessun contenuto clinico) con il link
// /t/<token>: il token in chiaro esiste solo nell'email; a DB resta l'hash
// SHA-256 (token_thread.token_hash), coerente con msg_leggi_thread/msg_rispondi.
//
// Auth: Authorization: Bearer <jwt medico> (stesso pattern di send-email PATH1).
// Superficie anonima: zero — il paziente passa SOLO dalle RPC DEFINER.
//
// POST { action: 'apri',   paziente_id? | appuntamento_id?, corpo?, durata_giorni? }
//        → 200 { thread_id } | 404 not_found | 409 email_mancante | 502 email_fallita
// POST { action: 'scrivi', thread_id, corpo }
//        → 200 { messaggio_id } | 404 not_found | 409 thread_chiuso | 502 email_fallita
// POST { action: 'chiudi', thread_id }
//        → 200 { ok: true }
// Rollback simmetrico: se l'email di apertura fallisce il thread viene cancellato.

import { Resend } from 'resend';
import { createHash, randomBytes } from 'crypto';

const MAX_CORPO = 4000;

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function checkMedicoAuth(jwt, supabaseUrl, anonKey, serviceKey) {
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': anonKey }
  }).catch(() => null);
  if (!userRes || !userRes.ok) return { ok: false, status: 401, error: 'Token non valido o scaduto' };
  const userData = await userRes.json().catch(() => null);
  if (!userData?.id) return { ok: false, status: 401, error: 'Utente non riconosciuto' };
  const medicoRes = await fetch(
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&stato=eq.approvato&deleted_at=is.null&select=id,titolo,nome,cognome,msg_durata_giorni,msg_tempi_risposta`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  ).catch(() => null);
  if (!medicoRes || !medicoRes.ok) return { ok: false, status: 403, error: 'Verifica account fallita' };
  const rows = await medicoRes.json().catch(() => []);
  if (!rows?.[0]) return { ok: false, status: 403, error: 'Account non autorizzato' };
  return { ok: true, medico: rows[0] };
}

function emailHtml({ medicoNome, link, tipo, tempiRisposta }) {
  const intro = tipo === 'apertura'
    ? `${esc(medicoNome)} ha aperto un canale di comunicazione con lei.`
    : `${esc(medicoNome)} le ha scritto un nuovo messaggio.`;
  const tempi = tempiRisposta ? `<div style="font-size:13px;color:#555;margin-top:14px">Tempi di risposta indicati dal medico: ${esc(tempiRisposta)}.</div>` : '';
  return `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a">
  <div style="font-size:18px;font-weight:700;margin-bottom:12px">Delphi~Med</div>
  <div style="font-size:15px;line-height:1.5">${intro}</div>
  <div style="font-size:15px;line-height:1.5;margin-top:10px">Per leggerlo e rispondere apra il link qui sotto. Conservi questa email: è la sua chiave per scrivere al medico in caso di necessità.</div>
  <div style="margin:22px 0">
    <a href="${esc(link)}" style="display:inline-block;background:#0D5C8C;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Apri il messaggio</a>
  </div>
  <div style="font-size:13px;color:#555;line-height:1.5">Se il pulsante non funziona, copi questo indirizzo nel browser:<br>${esc(link)}</div>
  ${tempi}
  <div style="font-size:12px;color:#888;margin-top:22px;line-height:1.5">Questo canale non è adatto alle urgenze: in caso di emergenza contatti il 112 o si rechi al pronto soccorso. Il link è personale: non lo inoltri ad altri.</div>
</div>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl  = process.env.SUPABASE_URL;
  const serviceKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey      = process.env.SUPABASE_ANON_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey || !resendApiKey) {
    console.error('[msg-thread] env vars mancanti');
    return res.status(500).json({ error: 'Configurazione server mancante' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Autenticazione richiesta' });
  const auth = await checkMedicoAuth(authHeader.slice(7), supabaseUrl, anonKey, serviceKey);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const medico = auth.medico;
  const medicoNome = [medico.titolo, medico.nome, medico.cognome].filter(Boolean).join(' ');

  const base = `${supabaseUrl}/rest/v1`;
  const dbHeaders = { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const sb = (path, opts = {}) => fetch(`${base}/${path}`, { ...opts, headers: { ...dbHeaders, ...(opts.headers || {}) } });
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'delphi-med.com').split(',')[0].trim();
  const resend = new Resend(resendApiKey);

  const body = req.body || {};
  const action = body.action;
  const corpo = typeof body.corpo === 'string' ? body.corpo.trim() : '';
  if (corpo.length > MAX_CORPO) return res.status(400).json({ error: 'corpo_troppo_lungo' });

  async function emitToken(threadId, expiresAt) {
    const token = randomBytes(32).toString('base64url');
    const r = await sb('token_thread', {
      method: 'POST',
      body: JSON.stringify({ token_hash: hashToken(token), thread_id: threadId, expires_at: expiresAt })
    });
    if (!r.ok) throw new Error('token_insert ' + r.status);
    return token;
  }

  async function sendMail(to, tipo, token) {
    const link = `https://${host}/t/${token}`;
    const ora = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
    const subject = tipo === 'apertura'
      ? `${medicoNome} ha aperto un canale con lei — Delphi~Med`
      : `Nuovo messaggio da ${medicoNome} (${ora}) — Delphi~Med`;
    const { data, error } = await resend.emails.send({
      from: 'noreply@delphi-med.com', to: [to], subject,
      html: emailHtml({ medicoNome, link, tipo, tempiRisposta: medico.msg_tempi_risposta })
    });
    if (error) throw new Error('resend ' + (error.message || 'errore'));
    return data?.id || null;
  }

  // Traccia dell'invio riuscito (soft-fail, come auditLog di send-email): solo dopo
  // che Resend ha accettato la mail, con il suo id. Nessuna traccia sui rami di rollback.
  async function auditInvio(threadId, tipoAudit, to, resendId) {
    try {
      const r = await sb('audit_log', {
        method: 'POST', headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          medico_id: medico.id, action: 'email_inviata', target_type: 'thread', target_id: String(threadId),
          details: { tipo: tipoAudit, auth_mode: 'jwt_medico', to, resend_id: resendId }
        })
      });
      if (!r.ok) console.error('[msg-thread] audit_log', r.status);
    } catch (e) {
      console.error('[msg-thread] audit_log:', e.message);
    }
  }

  // ── apri ──────────────────────────────────────────────────────────────────
  if (action === 'apri') {
    let pazienteId = body.paziente_id || null;
    let apptId = body.appuntamento_id || null;
    let email = null, tel = null;

    if (apptId) {
      const r = await sb(`appuntamenti?id=eq.${encodeURIComponent(apptId)}&medico_id=eq.${medico.id}&select=id,paziente_id,email_paziente,telefono_paziente`);
      const a = r.ok ? (await r.json())[0] : null;
      if (!a) return res.status(404).json({ error: 'not_found' });
      pazienteId = pazienteId || a.paziente_id || null;
      email = a.email_paziente || null; tel = a.telefono_paziente || null;
    }
    if (pazienteId) {
      const r = await sb(`pazienti?id=eq.${encodeURIComponent(pazienteId)}&medico_id=eq.${medico.id}&select=id,email,telefono`);
      const p = r.ok ? (await r.json())[0] : null;
      if (!p) return res.status(404).json({ error: 'not_found' });
      email = email || p.email || null; tel = tel || p.telefono || null;
    }
    if (!pazienteId && !apptId) return res.status(400).json({ error: 'destinatario_mancante' });
    if (!email) return res.status(409).json({ error: 'email_mancante' });

    const durata = Number.isInteger(body.durata_giorni) ? body.durata_giorni : (medico.msg_durata_giorni ?? 30);
    const scadeIl = durata > 0 ? new Date(Date.now() + durata * 86400000).toISOString() : null;
    const tokenExp = scadeIl || new Date(Date.now() + 365 * 86400000).toISOString();

    const tr = await sb('thread_messaggi', {
      method: 'POST', headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        medico_id: medico.id, paziente_id: pazienteId, appuntamento_id: apptId,
        origine: apptId ? 'visita' : 'manuale', recapito_email: email, recapito_tel: tel, scade_il: scadeIl
      })
    });
    if (!tr.ok) { console.error('[msg-thread] thread insert', tr.status); return res.status(500).json({ error: 'db' }); }
    const thread = (await tr.json())[0];

    let resendId = null;
    try {
      if (corpo) {
        const mr = await sb('messaggi', { method: 'POST', body: JSON.stringify({ thread_id: thread.id, direzione: 'medico', corpo }) });
        if (!mr.ok) throw new Error('messaggio_insert ' + mr.status);
      }
      const token = await emitToken(thread.id, tokenExp);
      resendId = await sendMail(email, 'apertura', token);
    } catch (e) {
      console.error('[msg-thread] apri rollback:', e.message);
      await sb(`thread_messaggi?id=eq.${thread.id}`, { method: 'DELETE' }).catch(() => {});
      return res.status(502).json({ error: 'email_fallita' });
    }
    await auditInvio(thread.id, 'msg_thread_apertura', email, resendId);
    return res.status(200).json({ thread_id: thread.id });
  }

  // ── scrivi ────────────────────────────────────────────────────────────────
  if (action === 'scrivi') {
    if (!body.thread_id || !corpo) return res.status(400).json({ error: 'parametri_mancanti' });
    const r = await sb(`thread_messaggi?id=eq.${encodeURIComponent(body.thread_id)}&medico_id=eq.${medico.id}&select=id,recapito_email,scade_il,chiuso_at`);
    const t = r.ok ? (await r.json())[0] : null;
    if (!t) return res.status(404).json({ error: 'not_found' });
    if (t.chiuso_at) return res.status(409).json({ error: 'thread_chiuso' });
    if (!t.recapito_email) return res.status(409).json({ error: 'email_mancante' });

    const mr = await sb('messaggi', {
      method: 'POST', headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ thread_id: t.id, direzione: 'medico', corpo })
    });
    if (!mr.ok) return res.status(500).json({ error: 'db' });
    const msg = (await mr.json())[0];

    let resendId = null;
    try {
      // tutti i link del canale restano validi (lettura e risposta) fino a scadenza o chiusura
      const tokenExp = t.scade_il || new Date(Date.now() + 365 * 86400000).toISOString();
      const token = await emitToken(t.id, tokenExp);
      resendId = await sendMail(t.recapito_email, 'nuovo', token);
    } catch (e) {
      console.error('[msg-thread] scrivi rollback:', e.message);
      await sb(`messaggi?id=eq.${msg.id}`, { method: 'DELETE' }).catch(() => {});
      return res.status(502).json({ error: 'email_fallita' });
    }
    await auditInvio(t.id, 'msg_thread_notifica', t.recapito_email, resendId);
    return res.status(200).json({ messaggio_id: msg.id });
  }

  // ── chiudi ────────────────────────────────────────────────────────────────
  if (action === 'chiudi') {
    if (!body.thread_id) return res.status(400).json({ error: 'parametri_mancanti' });
    const r = await sb(`thread_messaggi?id=eq.${encodeURIComponent(body.thread_id)}&medico_id=eq.${medico.id}&chiuso_at=is.null`, {
      method: 'PATCH', headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ chiuso_at: new Date().toISOString() })
    });
    const rows = r.ok ? await r.json() : [];
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    await sb(`token_thread?thread_id=eq.${rows[0].id}&revocato_at=is.null`, { method: 'PATCH', body: JSON.stringify({ revocato_at: new Date().toISOString() }) }).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'action_non_valida' });
}
