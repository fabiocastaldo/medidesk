/*
 * /api/send-email.js — endpoint email auth-aware
 *
 * PATH 1 (jwt_medico)        : Authorization: Bearer <Supabase JWT>
 *   Modalità: conferma_appt_medico, cancellazione_paziente,
 *             notifica_centro_evento, chiusura_studio_centro, account_eliminazione
 *
 * PATH 2 (email_token)       : body.email_token (jti opaco da tabella email_tokens)
 *   Modalità: conferma_appt_anon
 *
 * PATH 3 (cancellation_token): body.cancellation_token + body.appt_id
 *   Modalità: cancellazione_centro_anon
 *
 * Nessuna modalità HTML libero. Nessun rate limit in-memory.
 * Ogni invio riuscito produce un INSERT su audit_log (soft-fail).
 */

import { Resend } from 'resend';

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDateIt(dateStr) {
  try {
    return new Date(dateStr + 'T12:00:00')
      .toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } catch (_) { return dateStr || ''; }
}

// ── Audit log (soft-fail) ─────────────────────────────────────────────────────

async function auditLog(base, headers, medicoId, tipo, targetType, targetId, authMode, to, resendId) {
  try {
    await fetch(`${base}/audit_log`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        medico_id:   medicoId || null,
        action:      'email_inviata',
        target_type: targetType,
        target_id:   targetId ? String(targetId) : null,
        details:     { tipo, auth_mode: authMode, to, resend_id: resendId }
      })
    });
  } catch (e) {
    console.error('[send-email] auditLog failed:', e.message);
  }
}

// ── checkMedicoAuth ───────────────────────────────────────────────────────────
// Verifica JWT Supabase + medico approvato non eliminato.
// Ritorna { ok: true, medicoId, userId, userEmail, medicoNome }
// oppure   { ok: false, status, error }

async function checkMedicoAuth(jwt, supabaseUrl, anonKey, serviceKey) {
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': anonKey }
  }).catch(() => null);
  if (!userRes || !userRes.ok) {
    return { ok: false, status: 401, error: 'Token non valido o scaduto' };
  }
  const userData = await userRes.json().catch(() => null);
  if (!userData?.id) {
    return { ok: false, status: 401, error: 'Utente non riconosciuto' };
  }

  const medicoRes = await fetch(
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&stato=eq.approvato&deleted_at=is.null&select=id,titolo,nome,cognome`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  ).catch(() => null);
  if (!medicoRes || !medicoRes.ok) {
    return { ok: false, status: 403, error: 'Verifica account fallita' };
  }
  const rows = await medicoRes.json().catch(() => []);
  if (!rows?.[0]) {
    return { ok: false, status: 403, error: 'Account non autorizzato' };
  }
  const m = rows[0];
  return {
    ok: true,
    medicoId:   m.id,
    userId:     userData.id,
    userEmail:  userData.email,
    medicoNome: [m.titolo, m.nome, m.cognome].filter(Boolean).join(' ')
  };
}

// ── consumeEmailToken ─────────────────────────────────────────────────────────
// SELECT per discriminare 401/409, poi PATCH atomico WHERE used_at IS NULL AND expires_at > now.
// Ritorna { ok: true, apptId } oppure { ok: false, status, error }

async function consumeEmailToken(jti, supabaseUrl, serviceKey) {
  if (typeof jti !== 'string' || jti.trim() === '') {
    return { ok: false, status: 400, error: 'email_token mancante' };
  }
  const base = `${supabaseUrl}/rest/v1`;
  const headers = { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  // Step 1: verifica esistenza e stato per error code precisi
  let tokenRow;
  try {
    const r = await fetch(
      `${base}/email_tokens?jti=eq.${encodeURIComponent(jti)}&select=jti,appt_id,expires_at,used_at`,
      { headers }
    );
    if (!r.ok) throw new Error(`status ${r.status}`);
    const rows = await r.json();
    tokenRow = rows?.[0];
  } catch (e) {
    console.error('[send-email] consumeEmailToken SELECT:', e.message);
    return { ok: false, status: 500, error: 'Errore verifica token' };
  }
  if (!tokenRow) return { ok: false, status: 401, error: 'Token non valido' };
  if (tokenRow.used_at) return { ok: false, status: 409, error: 'Token già usato' };
  if (new Date(tokenRow.expires_at) < new Date()) return { ok: false, status: 401, error: 'Token scaduto' };

  // Step 2: PATCH atomico — segna usato solo se used_at IS NULL e non ancora scaduto
  let markedRows;
  try {
    const now = new Date().toISOString();
    const r = await fetch(
      `${base}/email_tokens?jti=eq.${encodeURIComponent(jti)}&used_at=is.null&expires_at=gt.${encodeURIComponent(now)}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify({ used_at: now })
      }
    );
    if (!r.ok) throw new Error(`status ${r.status}`);
    markedRows = await r.json().catch(() => []);
  } catch (e) {
    console.error('[send-email] consumeEmailToken PATCH:', e.message);
    return { ok: false, status: 500, error: 'Errore consumo token' };
  }
  if (!Array.isArray(markedRows) || markedRows.length === 0) {
    return { ok: false, status: 409, error: 'Token già usato' };
  }
  return { ok: true, apptId: tokenRow.appt_id };
}

// ── verifyCancellationToken ───────────────────────────────────────────────────
// Chiama RPC get_dati_notifica_cancellazione(p_appt_id, p_token).
// Ritorna { ok: true, notificaAbilitata, centroNome, centroEmail }
// oppure   { ok: false, status, error }

async function verifyCancellationToken(apptId, token, supabaseUrl, serviceKey) {
  if (!apptId || !token) {
    return { ok: false, status: 400, error: 'appt_id e cancellation_token obbligatori' };
  }
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/get_dati_notifica_cancellazione`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_appt_id: apptId, p_token: token })
    });
    if (!r.ok) return { ok: false, status: 401, error: 'Token di cancellazione non valido' };
    const rows = await r.json().catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return { ok: false, status: 401, error: 'Token di cancellazione non valido' };
    return {
      ok: true,
      notificaAbilitata: row.notifica_cancellazione,
      centroNome:        row.centro_nome,
      centroEmail:       row.centro_email
    };
  } catch (e) {
    console.error('[send-email] verifyCancellationToken:', e.message);
    return { ok: false, status: 500, error: 'Errore verifica token' };
  }
}

// ── lookupAppt ────────────────────────────────────────────────────────────────
// Tre query separate: appuntamento → medico → centro.
// Se medicoId != null: verifica ownership (appuntamento.medico_id === medicoId).
// Ritorna oggetto ricco oppure { ok: false, status, error }

async function lookupAppt(apptId, medicoId, supabaseUrl, serviceKey) {
  const base = `${supabaseUrl}/rest/v1`;
  const headers = { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` };

  let appt;
  try {
    const r = await fetch(`${base}/appuntamenti?id=eq.${encodeURIComponent(apptId)}&select=*`, { headers });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const rows = await r.json();
    appt = rows?.[0];
  } catch (e) {
    console.error('[send-email] lookupAppt fetch appt:', e.message);
    return { ok: false, status: 500, error: 'Errore lookup appuntamento' };
  }
  if (!appt) return { ok: false, status: 404, error: 'Appuntamento non trovato' };
  if (medicoId && appt.medico_id !== medicoId) {
    return { ok: false, status: 403, error: "Accesso non autorizzato all'appuntamento" };
  }

  let medico = {};
  try {
    const r = await fetch(
      `${base}/medici?id=eq.${encodeURIComponent(appt.medico_id)}&select=id,titolo,nome,cognome,email,slug`,
      { headers }
    );
    if (r.ok) { const rows = await r.json(); medico = rows?.[0] || {}; }
  } catch (e) { console.error('[send-email] lookupAppt fetch medico:', e.message); }

  let centro = {};
  try {
    const r = await fetch(
      `${base}/centri?id=eq.${encodeURIComponent(appt.centro_id)}&select=id,nome,email_segreteria`,
      { headers }
    );
    if (r.ok) { const rows = await r.json(); centro = rows?.[0] || {}; }
  } catch (e) { console.error('[send-email] lookupAppt fetch centro:', e.message); }

  return {
    ok: true,
    apptMedicoId:      appt.medico_id,
    emailPaziente:     appt.email_paziente,
    pazienteNome:      [appt.nome_paziente, appt.cognome_paziente].filter(Boolean).join(' '),
    data:              appt.data,
    ora:               appt.ora,
    tipoVisita:        appt.tipo_visita,
    cancellationToken: appt.cancellation_token,
    medicoNome:        [medico.titolo, medico.nome, medico.cognome].filter(Boolean).join(' ') || 'il medico',
    medicoEmail:       medico.email || null,
    medicoSlug:        medico.slug || null,
    centroNome:        centro.nome || '',
    centroEmail:       centro.email_segreteria || null
  };
}

// ── lookupChiusura ────────────────────────────────────────────────────────────
// Ownership triplice:
//   a) chiusura.medico_id === userId
//   b) centro_id ∈ chiusura.centri_ids
//   c) centro.medico_id === userId
// Ritorna { ok: true, dataInizio, dataFine, etichetta, centroNome, centroEmail }
// oppure  { ok: false, status, error }

async function lookupChiusura(chiusuraId, centroId, userId, supabaseUrl, serviceKey) {
  const base = `${supabaseUrl}/rest/v1`;
  const headers = { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` };

  let chiusura;
  try {
    const r = await fetch(
      `${base}/chiusure?id=eq.${encodeURIComponent(chiusuraId)}&select=id,medico_id,data_inizio,data_fine,etichetta,centri_ids`,
      { headers }
    );
    if (!r.ok) throw new Error(`status ${r.status}`);
    const rows = await r.json();
    chiusura = rows?.[0];
  } catch (e) {
    console.error('[send-email] lookupChiusura fetch chiusura:', e.message);
    return { ok: false, status: 500, error: 'Errore lookup chiusura' };
  }
  if (!chiusura) return { ok: false, status: 404, error: 'Chiusura non trovata' };
  // Check a
  if (chiusura.medico_id !== userId) return { ok: false, status: 403, error: 'Accesso non autorizzato alla chiusura' };
  // Check b
  if (!Array.isArray(chiusura.centri_ids) || !chiusura.centri_ids.includes(centroId)) {
    return { ok: false, status: 400, error: 'Il centro specificato non è incluso in questa chiusura' };
  }

  let centro;
  try {
    const r = await fetch(
      `${base}/centri?id=eq.${encodeURIComponent(centroId)}&select=id,nome,email_segreteria,medico_id`,
      { headers }
    );
    if (!r.ok) throw new Error(`status ${r.status}`);
    const rows = await r.json();
    centro = rows?.[0];
  } catch (e) {
    console.error('[send-email] lookupChiusura fetch centro:', e.message);
    return { ok: false, status: 500, error: 'Errore lookup centro' };
  }
  if (!centro) return { ok: false, status: 404, error: 'Centro non trovato' };
  // Check c
  if (centro.medico_id !== userId) return { ok: false, status: 403, error: 'Accesso non autorizzato al centro' };
  if (!centro.email_segreteria) return { ok: false, status: 400, error: 'Il centro non ha un indirizzo email di segreteria configurato' };

  return {
    ok: true,
    dataInizio:  chiusura.data_inizio,
    dataFine:    chiusura.data_fine,
    etichetta:   chiusura.etichetta || null,
    centroNome:  centro.nome,
    centroEmail: centro.email_segreteria
  };
}

// ── Handler principale ────────────────────────────────────────────────────────

const VALID_TIPI = new Set([
  'conferma_appt_anon', 'conferma_appt_medico', 'cancellazione_paziente',
  'notifica_centro_evento', 'cancellazione_centro_anon', 'chiusura_studio_centro',
  'account_eliminazione'
]);

const PATH1_TIPI = new Set([
  'conferma_appt_medico', 'cancellazione_paziente', 'notifica_centro_evento',
  'chiusura_studio_centro', 'account_eliminazione'
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl  = process.env.SUPABASE_URL;
  const serviceKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey      = process.env.SUPABASE_ANON_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey || !resendApiKey) {
    console.error('[send-email] env vars mancanti');
    return res.status(500).json({ error: 'Configurazione server mancante' });
  }

  const body = req.body || {};
  const { tipo } = body;
  if (!tipo || !VALID_TIPI.has(tipo)) {
    return res.status(400).json({ error: 'Campo tipo mancante o non valido' });
  }

  const base = `${supabaseUrl}/rest/v1`;
  const dbHeaders = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };
  const resend = new Resend(resendApiKey);

  // ── Auth routing ──────────────────────────────────────────────────────────────

  let authCtx = {};

  if (PATH1_TIPI.has(tipo)) {
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Autenticazione richiesta' });
    }
    const auth = await checkMedicoAuth(authHeader.slice(7), supabaseUrl, anonKey, serviceKey);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    authCtx = { medicoId: auth.medicoId, userId: auth.userId, userEmail: auth.userEmail, medicoNome: auth.medicoNome, authMode: 'jwt_medico' };

  } else if (tipo === 'conferma_appt_anon') {
    const tok = await consumeEmailToken(body.email_token, supabaseUrl, serviceKey);
    if (!tok.ok) return res.status(tok.status).json({ error: tok.error });
    authCtx = { apptIdFromToken: tok.apptId, authMode: 'email_token' };

  } else if (tipo === 'cancellazione_centro_anon') {
    const ct = await verifyCancellationToken(body.appt_id, body.cancellation_token, supabaseUrl, serviceKey);
    if (!ct.ok) return res.status(ct.status).json({ error: ct.error });
    if (!ct.notificaAbilitata) {
      console.log('[send-email] cancellazione_centro_anon: notifiche disabilitate', { appt_id: body.appt_id });
      return res.status(200).json({ ok: true, skipped: 'notifiche disabilitate per il centro' });
    }
    authCtx = { centroNome: ct.centroNome, centroEmail: ct.centroEmail, authMode: 'cancellation_token' };
  }

  // ── Per-tipo: lookup DB + costruzione payload email ───────────────────────────

  let to, subject, html, replyTo, medicoIdAudit, targetType, targetId;

  if (tipo === 'conferma_appt_anon') {
    const appt = await lookupAppt(authCtx.apptIdFromToken, null, supabaseUrl, serviceKey);
    if (!appt.ok) return res.status(appt.status).json({ error: appt.error });
    const dataFmt = formatDateIt(appt.data);
    to            = appt.emailPaziente;
    subject       = `Conferma appuntamento con ${appt.medicoNome}`;
    html          = buildHtml({ paziente_nome: esc(appt.pazienteNome), medico_nome: esc(appt.medicoNome), centro_nome: esc(appt.centroNome), dataFmt: esc(dataFmt), ora: esc(appt.ora), tipo_visita: esc(appt.tipoVisita) || '&mdash;', codice_cancellazione: esc(appt.cancellationToken) });
    replyTo       = appt.medicoEmail;
    medicoIdAudit = appt.apptMedicoId;
    targetType    = 'appuntamento';
    targetId      = authCtx.apptIdFromToken;

  } else if (tipo === 'conferma_appt_medico') {
    const { appt_id } = body;
    if (!appt_id) return res.status(400).json({ error: 'appt_id obbligatorio' });
    const appt = await lookupAppt(appt_id, authCtx.medicoId, supabaseUrl, serviceKey);
    if (!appt.ok) return res.status(appt.status).json({ error: appt.error });
    const dataFmt = formatDateIt(appt.data);
    to            = appt.emailPaziente;
    subject       = `Conferma appuntamento con ${appt.medicoNome}`;
    html          = buildHtml({ paziente_nome: esc(appt.pazienteNome), medico_nome: esc(appt.medicoNome), centro_nome: esc(appt.centroNome), dataFmt: esc(dataFmt), ora: esc(appt.ora), tipo_visita: esc(appt.tipoVisita) || '&mdash;', codice_cancellazione: esc(appt.cancellationToken) });
    replyTo       = appt.medicoEmail;
    medicoIdAudit = authCtx.medicoId;
    targetType    = 'appuntamento';
    targetId      = appt_id;

  } else if (tipo === 'cancellazione_paziente') {
    const { appt_id } = body;
    if (!appt_id) return res.status(400).json({ error: 'appt_id obbligatorio' });
    const appt = await lookupAppt(appt_id, authCtx.medicoId, supabaseUrl, serviceKey);
    if (!appt.ok) return res.status(appt.status).json({ error: appt.error });
    const dataFmt = formatDateIt(appt.data);
    to            = appt.emailPaziente;
    subject       = `Appuntamento annullato — ${dataFmt} alle ${appt.ora}`;
    html          = buildHtmlCancellazioneMedico({ paziente_nome: esc(appt.pazienteNome), medico_nome: esc(appt.medicoNome), centro_nome: esc(appt.centroNome), dataFmt, ora: esc(appt.ora), medico_slug: appt.medicoSlug || '' });
    replyTo       = appt.medicoEmail;
    medicoIdAudit = authCtx.medicoId;
    targetType    = 'appuntamento';
    targetId      = appt_id;

  } else if (tipo === 'notifica_centro_evento') {
    const { appt_id, evento } = body;
    if (!appt_id) return res.status(400).json({ error: 'appt_id obbligatorio' });
    const EVENTI_VALIDI = ['nuova_prenotazione', 'appuntamento_manuale', 'cancellazione'];
    if (!evento || !EVENTI_VALIDI.includes(evento)) {
      return res.status(400).json({ error: `evento deve essere uno di: ${EVENTI_VALIDI.join(', ')}` });
    }
    const appt = await lookupAppt(appt_id, authCtx.medicoId, supabaseUrl, serviceKey);
    if (!appt.ok) return res.status(appt.status).json({ error: appt.error });
    if (!appt.centroEmail) return res.status(400).json({ error: 'Il centro non ha un indirizzo email configurato' });
    const dataFmt = formatDateIt(appt.data);
    const soggetti = { nuova_prenotazione: 'Nuova prenotazione', appuntamento_manuale: 'Nuovo appuntamento', cancellazione: 'Cancellazione appuntamento' };
    to            = appt.centroEmail;
    subject       = `${soggetti[evento]} — ${appt.pazienteNome}, ${dataFmt}`;
    html          = buildHtmlNotificaCentro({ evento, paziente_nome: esc(appt.pazienteNome), data_fmt: esc(dataFmt), ora: esc(appt.ora), tipo_visita: esc(appt.tipoVisita), medico_nome: esc(appt.medicoNome), centro_nome: esc(appt.centroNome) });
    replyTo       = appt.medicoEmail;
    medicoIdAudit = authCtx.medicoId;
    targetType    = 'appuntamento';
    targetId      = appt_id;

  } else if (tipo === 'cancellazione_centro_anon') {
    const { appt_id } = body;
    // lookupAppt senza ownership check: auth già validata dalla RPC
    const appt = await lookupAppt(appt_id, null, supabaseUrl, serviceKey);
    if (!appt.ok) return res.status(appt.status).json({ error: appt.error });
    const dataFmt = formatDateIt(appt.data);
    to            = authCtx.centroEmail;
    subject       = `Cancellazione appuntamento — ${appt.pazienteNome}, ${dataFmt}`;
    html          = buildHtmlNotificaCentro({ evento: 'cancellazione', paziente_nome: esc(appt.pazienteNome), data_fmt: esc(dataFmt), ora: esc(appt.ora), tipo_visita: esc(appt.tipoVisita), medico_nome: esc(appt.medicoNome), centro_nome: esc(authCtx.centroNome) });
    replyTo       = null;
    medicoIdAudit = appt.apptMedicoId;
    targetType    = 'appuntamento';
    targetId      = appt_id;

  } else if (tipo === 'chiusura_studio_centro') {
    const { chiusura_id, centro_id } = body;
    if (!chiusura_id || !centro_id) return res.status(400).json({ error: 'chiusura_id e centro_id obbligatori' });
    const ch = await lookupChiusura(chiusura_id, centro_id, authCtx.userId, supabaseUrl, serviceKey);
    if (!ch.ok) return res.status(ch.status).json({ error: ch.error });
    const dataInizioFmt = formatDateIt(ch.dataInizio);
    const dataFineFmt   = formatDateIt(ch.dataFine);
    to            = ch.centroEmail;
    subject       = `Chiusura studio — ${ch.etichetta || dataInizioFmt}`;
    html          = buildHtmlChiusura({ data_inizio_fmt: esc(dataInizioFmt), data_fine_fmt: esc(dataFineFmt), etichetta: esc(ch.etichetta), centro_nome: esc(ch.centroNome), medico_nome: esc(authCtx.medicoNome) });
    replyTo       = authCtx.userEmail;
    medicoIdAudit = authCtx.medicoId;
    targetType    = 'centro';
    targetId      = chiusura_id;

  } else if (tipo === 'account_eliminazione') {
    to            = authCtx.userEmail;
    subject       = 'Account Delphi⁠~Med — eliminazione programmata';
    html          = buildHtmlAccountEliminazione({ medico_nome: esc(authCtx.medicoNome) });
    replyTo       = null;
    medicoIdAudit = authCtx.medicoId;
    targetType    = 'account';
    targetId      = authCtx.medicoId;
  }

  // Destinatario sanity check
  if (!to || typeof to !== 'string' || !to.includes('@')) {
    return res.status(400).json({ error: 'Destinatario email non disponibile o non valido' });
  }

  // ── Invio via Resend ──────────────────────────────────────────────────────────

  let resendId;
  try {
    const payload = { from: 'noreply@delphi-med.com', to: [to], subject, html };
    if (replyTo) payload.reply_to = replyTo;
    const { data: sendData, error: sendErr } = await resend.emails.send(payload);
    if (sendErr) {
      console.error('[send-email] resend error:', sendErr.message, { tipo, to });
      return res.status(500).json({ error: 'Errore invio email' });
    }
    resendId = sendData?.id;
    console.log('[send-email] email inviata', { tipo, to, resend_id: resendId });
  } catch (e) {
    console.error('[send-email] resend exception:', e.message);
    return res.status(500).json({ error: 'Errore invio email' });
  }

  // ── Audit log (soft-fail) ─────────────────────────────────────────────────────

  await auditLog(base, dbHeaders, medicoIdAudit, tipo, targetType, targetId, authCtx.authMode, to, resendId);

  return res.status(200).json({ ok: true });
}

// ── Template HTML ─────────────────────────────────────────────────────────────

function buildHtmlCancellazioneMedico({ paziente_nome, medico_nome, centro_nome, dataFmt, ora, medico_slug }) {
  const bookingLink = medico_slug ? `https://delphi-med.com/?booking&doc=${encodeURIComponent(medico_slug)}` : '';
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f4f4;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f4;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:560px;">
  <tr>
    <td style="background:#0D9488;padding:32px 40px;text-align:center;">
      <p style="margin:0;font-size:30px;color:#ffffff;">&#9888;</p>
      <p style="margin:8px 0 0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.3px;">Appuntamento annullato</p>
    </td>
  </tr>
  <tr>
    <td style="padding:36px 40px;">
      <p style="font-size:16px;color:#1a1a1a;margin:0 0 20px;">Gentile <strong>${paziente_nome}</strong>,</p>
      <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 28px;">
        la informiamo che l&apos;appuntamento del <strong>${dataFmt}</strong> alle ore <strong>${ora}</strong> presso <strong>${centro_nome}</strong> con il medico <strong>${medico_nome}</strong> &egrave; stato annullato.
      </p>
      ${bookingLink
        ? `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 20px;">Per riprenotare la visita, pu&ograve; contattare direttamente il centro oppure consultare i nuovi orari disponibili:</p>
           <div style="text-align:center;margin:0 0 28px;">
             <a href="${bookingLink}" style="display:inline-block;padding:12px 24px;background:#0D9488;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;">Prenota un nuovo appuntamento</a>
           </div>`
        : `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 28px;">Per riprenotare la visita, pu&ograve; contattare direttamente il centro.</p>`
      }
      <p style="font-size:13px;color:#555;line-height:1.6;margin:0;">Ci scusiamo per l&apos;inconveniente.<br><br>Cordiali saluti.</p>
    </td>
  </tr>
  <tr>
    <td style="background:#f8f8f8;border-top:1px solid #eeeeee;padding:18px 40px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#bbb;">Messaggio inviato automaticamente da MediDesk</p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function buildHtml({ paziente_nome, medico_nome, centro_nome, dataFmt, ora, tipo_visita, codice_cancellazione }) {
  const cancelUrl = 'https://delphi-med.com/?cancel=' + encodeURIComponent(codice_cancellazione);
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f4f4;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f4;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:560px;">
  <tr>
    <td style="background:#0D9488;padding:32px 40px;text-align:center;">
      <p style="margin:0;font-size:30px;color:#ffffff;">&#10003;</p>
      <p style="margin:8px 0 0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.3px;">Appuntamento confermato</p>
    </td>
  </tr>
  <tr>
    <td style="padding:36px 40px;">
      <p style="font-size:16px;color:#1a1a1a;margin:0 0 20px;">Gentile <strong>${paziente_nome}</strong>,</p>
      <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 28px;">
        La tua prenotazione con <strong>${medico_nome}</strong> &egrave; confermata.<br>
        Di seguito il riepilogo del tuo appuntamento.
      </p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdfb;border:1px solid #ccece9;border-radius:8px;margin-bottom:28px;">
        <tr><td style="padding:20px 24px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:8px 0;border-bottom:1px solid #d9f0ee;">
              <span style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">&#127973;&nbsp; Centro medico</span><br>
              <strong style="color:#111;font-size:14px;">${centro_nome}</strong>
            </td></tr>
            <tr><td style="padding:8px 0;border-bottom:1px solid #d9f0ee;">
              <span style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">&#128197;&nbsp; Data</span><br>
              <strong style="color:#111;font-size:14px;">${dataFmt}</strong>
            </td></tr>
            <tr><td style="padding:8px 0;border-bottom:1px solid #d9f0ee;">
              <span style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">&#128336;&nbsp; Ora</span><br>
              <strong style="color:#111;font-size:14px;">${ora}</strong>
            </td></tr>
            <tr><td style="padding:8px 0;">
              <span style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">&#129658;&nbsp; Tipo visita</span><br>
              <strong style="color:#111;font-size:14px;">${tipo_visita}</strong>
            </td></tr>
          </table>
        </td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border-left:3px solid #f59e0b;border-radius:0 6px 6px 0;margin-bottom:28px;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0;font-size:13px;color:#555;line-height:1.6;">
            &#128203; <strong>Ricorda di portare</strong> la tua documentazione sanitaria: tessera sanitaria, referti e risultati di esami precedenti, e ogni altro documento rilevante per la visita.
          </p>
        </td></tr>
      </table>
      <p style="font-size:13px;color:#555;line-height:1.6;text-align:center;margin:24px auto 12px;max-width:480px;">
        Se non puoi venire, ti chiediamo gentilmente di cancellare il prima possibile: lo slot torner&agrave; subito disponibile per un altro paziente che ne ha bisogno.
      </p>
      <div style="text-align:center;margin:0 0 28px;">
        <a href="${cancelUrl}" style="display:inline-block;padding:12px 24px;background:#0D9488;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;">Cancella l&rsquo;appuntamento</a>
      </div>
    </td>
  </tr>
  <tr>
    <td style="background:#f8f8f8;border-top:1px solid #eeeeee;padding:18px 40px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#bbb;">Messaggio inviato automaticamente da MediDesk</p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function buildHtmlNotificaCentro({ evento, paziente_nome, data_fmt, ora, tipo_visita, medico_nome, centro_nome }) {
  const LABELS = { nuova_prenotazione: 'Nuova prenotazione', appuntamento_manuale: 'Nuovo appuntamento', cancellazione: 'Cancellazione appuntamento' };
  const ICONS  = { nuova_prenotazione: '&#128197;', appuntamento_manuale: '&#128203;', cancellazione: '&#9888;' };
  const label  = LABELS[evento] || evento;
  const icon   = ICONS[evento]  || '&#128276;';

  const rows = [
    `<tr><td style="padding:8px 0;border-bottom:1px solid #d9f0ee;"><span style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">&#128100;&nbsp; Paziente</span><br><strong style="color:#111;font-size:14px;">${paziente_nome}</strong></td></tr>`,
    `<tr><td style="padding:8px 0;border-bottom:1px solid #d9f0ee;"><span style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">&#128100;&nbsp; Medico</span><br><strong style="color:#111;font-size:14px;">${medico_nome}</strong></td></tr>`,
    `<tr><td style="padding:8px 0;border-bottom:1px solid #d9f0ee;"><span style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">&#128197;&nbsp; Data</span><br><strong style="color:#111;font-size:14px;">${data_fmt}</strong></td></tr>`,
    `<tr><td style="padding:8px 0;${tipo_visita ? 'border-bottom:1px solid #d9f0ee;' : ''}"><span style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">&#128336;&nbsp; Ora</span><br><strong style="color:#111;font-size:14px;">${ora}</strong></td></tr>`,
    tipo_visita ? `<tr><td style="padding:8px 0;"><span style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">&#129658;&nbsp; Tipo visita</span><br><strong style="color:#111;font-size:14px;">${tipo_visita}</strong></td></tr>` : ''
  ].join('');

  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f4f4;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f4;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:560px;">
  <tr>
    <td style="background:#0D9488;padding:32px 40px;text-align:center;">
      <p style="margin:0;font-size:30px;color:#ffffff;">${icon}</p>
      <p style="margin:8px 0 0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.3px;">${label}</p>
      <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px;">${centro_nome}</p>
    </td>
  </tr>
  <tr>
    <td style="padding:36px 40px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdfb;border:1px solid #ccece9;border-radius:8px;margin-bottom:28px;">
        <tr><td style="padding:20px 24px;">
          <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        </td></tr>
      </table>
      <p style="font-size:12px;color:#aaa;text-align:center;margin:0;">Notifica automatica da Delphi&tilde;Med</p>
    </td>
  </tr>
  <tr>
    <td style="background:#f8f8f8;border-top:1px solid #eeeeee;padding:18px 40px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#bbb;">Messaggio inviato automaticamente da MediDesk</p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function buildHtmlChiusura({ data_inizio_fmt, data_fine_fmt, etichetta, centro_nome, medico_nome }) {
  const periodo = data_inizio_fmt === data_fine_fmt
    ? `il <strong>${data_inizio_fmt}</strong>`
    : `dal <strong>${data_inizio_fmt}</strong> al <strong>${data_fine_fmt}</strong>`;
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f4f4;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f4;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:560px;">
  <tr>
    <td style="background:#0D9488;padding:32px 40px;text-align:center;">
      <p style="margin:0;font-size:30px;color:#ffffff;">&#128274;</p>
      <p style="margin:8px 0 0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.3px;">Chiusura studio programmata</p>
      <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px;">${centro_nome}</p>
    </td>
  </tr>
  <tr>
    <td style="padding:36px 40px;">
      <p style="font-size:15px;color:#1a1a1a;margin:0 0 20px;">Gentile <strong>${centro_nome}</strong>,</p>
      <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 24px;">
        il medico <strong>${medico_nome}</strong> ha programmato una chiusura dello studio${etichetta ? ` (<em>${etichetta}</em>)` : ''} ${periodo}.
      </p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border-left:3px solid #f59e0b;border-radius:0 6px 6px 0;margin-bottom:24px;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0;font-size:13px;color:#555;line-height:1.6;">
            &#128203; In questo periodo non verranno generati nuovi slot prenotabili. Gli appuntamenti gi&agrave; confermati restano in agenda.
          </p>
        </td></tr>
      </table>
      <p style="font-size:13px;color:#888;margin:0;">Per informazioni contattare direttamente il medico.</p>
    </td>
  </tr>
  <tr>
    <td style="background:#f8f8f8;border-top:1px solid #eeeeee;padding:18px 40px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#bbb;">Messaggio inviato automaticamente da MediDesk</p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function buildHtmlAccountEliminazione({ medico_nome }) {
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f4f4;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f4;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:560px;">
  <tr>
    <td style="background:#dc2626;padding:32px 40px;text-align:center;">
      <p style="margin:0;font-size:30px;color:#ffffff;">&#128683;</p>
      <p style="margin:8px 0 0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.3px;">Eliminazione account programmata</p>
      <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px;">Delphi~Med</p>
    </td>
  </tr>
  <tr>
    <td style="padding:36px 40px;">
      <p style="font-size:16px;color:#1a1a1a;margin:0 0 16px;">Gentile <strong>${medico_nome}</strong>,</p>
      <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 20px;">
        abbiamo ricevuto una richiesta di eliminazione del tuo account Delphi&tilde;Med. La procedura &egrave; stata avviata.
      </p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border-left:3px solid #dc2626;border-radius:0 6px 6px 0;margin-bottom:24px;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0;font-size:13px;color:#555;line-height:1.6;">
            Se non sei stato tu a richiedere l&rsquo;eliminazione, contatta immediatamente il supporto a <a href="mailto:support@delphi-med.com" style="color:#dc2626;">support@delphi-med.com</a>.
          </p>
        </td></tr>
      </table>
      <p style="font-size:13px;color:#888;margin:0;">Grazie per aver utilizzato Delphi&tilde;Med.</p>
    </td>
  </tr>
  <tr>
    <td style="background:#f8f8f8;border-top:1px solid #eeeeee;padding:18px 40px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#bbb;">Messaggio inviato automaticamente da Delphi~Med</p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
