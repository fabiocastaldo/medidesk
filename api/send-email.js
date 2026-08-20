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
import { emailShell, emailTitle, detailCard, detailRow, noteBox, ctaButton } from '../lib/email-shell.js';
import { buildICS } from '../lib/ics-builder.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function redactEmail(e) {
  if (!e || typeof e !== 'string') return e;
  const [u, d] = e.split('@');
  if (!d) return '***';
  return `${u.slice(0, 1)}***@${d}`;
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
      `${base}/medici?id=eq.${encodeURIComponent(appt.medico_id)}&select=id,titolo,nome,cognome,email,slug,notifica_nuova_prenotazione,mail_medico_prenotazione,mail_medico_appuntamento,mail_medico_cancellazione`,
      { headers }
    );
    if (r.ok) { const rows = await r.json(); medico = rows?.[0] || {}; }
  } catch (e) { console.error('[send-email] lookupAppt fetch medico:', e.message); }

  let centro = {};
  try {
    const r = await fetch(
      `${base}/centri?id=eq.${encodeURIComponent(appt.centro_id)}&select=id,nome,email_segreteria,via,cap,citta,provincia`,
      { headers }
    );
    if (r.ok) { const rows = await r.json(); centro = rows?.[0] || {}; }
  } catch (e) { console.error('[send-email] lookupAppt fetch centro:', e.message); }

  return {
    ok: true,
    apptId:            appt.id,
    apptMedicoId:      appt.medico_id,
    emailPaziente:     appt.email_paziente,
    pazienteNome:      [appt.nome_paziente, appt.cognome_paziente].filter(Boolean).join(' '),
    data:              appt.data,
    ora:               (appt.ora || '').substring(0, 5),
    tipoVisita:        appt.tipo_visita,
    cancellationToken: appt.cancellation_token,
    medicoNome:        [medico.titolo, medico.nome, medico.cognome].filter(Boolean).join(' ') || 'il medico',
    medicoEmail:       medico.email || null,
    medicoSlug:        medico.slug || null,
    centroNome:        centro.nome || '',
    centroIndirizzo:   [centro.via, [centro.cap, centro.citta].filter(Boolean).join(' '), centro.provincia].filter(Boolean).join(', '),
    centroEmail:       centro.email_segreteria || null,
    notificaNuovaPrenotazione: medico.notifica_nuova_prenotazione !== false,
    mailMedicoPrenotazione: medico.mail_medico_prenotazione !== false,
    mailMedicoAppuntamento: medico.mail_medico_appuntamento === true,
    mailMedicoCancellazione: medico.mail_medico_cancellazione !== false
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
  // Check b — vincolo solo se la chiusura è circoscritta a centri specifici.
  // centri_ids vuoto = chiusura globale (vale per tutti i centri del medico): nessun vincolo qui;
  // l'ownership resta garantita dai check a (chiusura.medico_id) e c (centro.medico_id).
  if (Array.isArray(chiusura.centri_ids) && chiusura.centri_ids.length && !chiusura.centri_ids.includes(centroId)) {
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
  'account_eliminazione', 'notifica_prenotazione_coop',
  'conferma_prenotazione_segreteria', 'notifica_medico_prenotazione',
  'notifica_medico_cancellazione', 'notifica_medico_appuntamento'
]);

const PATH1_TIPI = new Set([
  'notifica_medico_appuntamento',
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
  const icsHost = (req.headers['x-forwarded-host'] || req.headers.host || 'delphi-med.com').split(',')[0].trim();
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
  } else if (tipo === 'notifica_prenotazione_coop' || tipo === 'conferma_prenotazione_segreteria' || tipo === 'notifica_medico_prenotazione' || tipo === 'notifica_medico_cancellazione') {
    const ct = await verifyCancellationToken(body.appt_id, body.cancellation_token, supabaseUrl, serviceKey);
    if (!ct.ok) return res.status(ct.status).json({ error: ct.error });
    authCtx = { authMode: 'cancellation_token' };
  }

  // ── Per-tipo: lookup DB + costruzione payload email ───────────────────────────

  let to, subject, html, replyTo, medicoIdAudit, targetType, targetId, icsAttachment;

  if (tipo === 'conferma_appt_anon') {
    const appt = await lookupAppt(authCtx.apptIdFromToken, null, supabaseUrl, serviceKey);
    if (!appt.ok) return res.status(appt.status).json({ error: appt.error });
    const dataFmt = formatDateIt(appt.data);
    to            = appt.emailPaziente;
    subject       = `Conferma appuntamento con ${appt.medicoNome}`;
    html          = buildHtml({ paziente_nome: esc(appt.pazienteNome), medico_nome: esc(appt.medicoNome), centro_nome: esc(appt.centroNome), dataFmt: esc(dataFmt), ora: esc(appt.ora), tipo_visita: esc(appt.tipoVisita) || '&mdash;', codice_cancellazione: esc(appt.cancellationToken), data_raw: appt.data, appt_id: appt.apptId, centro_indirizzo: appt.centroIndirizzo, ics_host: icsHost });
    if (appt.apptId && appt.data && appt.ora) {
      const _ics = buildICS({ apptId: appt.apptId, data: appt.data, ora: appt.ora, summary: buildIcsSummary(appt.tipoVisita, appt.medicoNome), description: appt.medicoNome ? `Prenotazione confermata con ${appt.medicoNome}` : 'Prenotazione confermata', location: [appt.centroNome, appt.centroIndirizzo].filter(Boolean).join(', ') });
      icsAttachment = { filename: 'appuntamento.ics', content: Buffer.from(_ics).toString('base64'), contentType: 'text/calendar; charset=utf-8' };
    }
    replyTo       = appt.medicoEmail;
    medicoIdAudit = appt.apptMedicoId;
    targetType    = 'appuntamento';
    targetId      = authCtx.apptIdFromToken;

    // Notifica al centro (best-effort, soft-fail): solo se il medico ha il toggle attivo
    // e il centro ha email. Sostituisce la chiamata frontend rimossa da confirmBooking (#3).
    if (appt.notificaNuovaPrenotazione && appt.centroEmail && body.skip_notifica_centro !== true) {
      try {
        const htmlCentro = buildHtmlNotificaCentro({
          evento: 'nuova_prenotazione',
          paziente_nome: esc(appt.pazienteNome),
          data_fmt: esc(dataFmt),
          ora: esc(appt.ora),
          tipo_visita: esc(appt.tipoVisita),
          medico_nome: esc(appt.medicoNome),
          centro_nome: esc(appt.centroNome)
        });
        const centroPayload = {
          from: 'noreply@delphi-med.com',
          to: [appt.centroEmail],
          subject: `Nuova prenotazione — ${appt.pazienteNome}, ${dataFmt}`,
          html: htmlCentro
        };
        if (appt.medicoEmail) centroPayload.reply_to = appt.medicoEmail;
        const { data: cData, error: cErr } = await resend.emails.send(centroPayload);
        if (cErr) {
          console.error('[send-email] notifica centro anon error:', cErr.message);
        } else {
          console.log('[send-email] notifica centro anon inviata', { to: redactEmail(appt.centroEmail), resend_id: cData?.id });
          await auditLog(base, dbHeaders, appt.apptMedicoId, 'notifica_centro_evento', 'appuntamento', authCtx.apptIdFromToken, 'email_token', appt.centroEmail, cData?.id);
        }
      } catch (e) {
        console.error('[send-email] notifica centro anon exception:', e.message);
      }
    }

  } else if (tipo === 'conferma_appt_medico') {
    const { appt_id } = body;
    if (!appt_id) return res.status(400).json({ error: 'appt_id obbligatorio' });
    const appt = await lookupAppt(appt_id, authCtx.medicoId, supabaseUrl, serviceKey);
    if (!appt.ok) return res.status(appt.status).json({ error: appt.error });
    const dataFmt = formatDateIt(appt.data);
    to            = appt.emailPaziente;
    subject       = `Conferma appuntamento con ${appt.medicoNome}`;
    html          = buildHtml({ paziente_nome: esc(appt.pazienteNome), medico_nome: esc(appt.medicoNome), centro_nome: esc(appt.centroNome), dataFmt: esc(dataFmt), ora: esc(appt.ora), tipo_visita: esc(appt.tipoVisita) || '&mdash;', codice_cancellazione: esc(appt.cancellationToken), data_raw: appt.data, appt_id: appt.apptId, centro_indirizzo: appt.centroIndirizzo, ics_host: icsHost });
    if (appt.apptId && appt.data && appt.ora) {
      const _ics = buildICS({ apptId: appt.apptId, data: appt.data, ora: appt.ora, summary: buildIcsSummary(appt.tipoVisita, appt.medicoNome), description: appt.medicoNome ? `Prenotazione confermata con ${appt.medicoNome}` : 'Prenotazione confermata', location: [appt.centroNome, appt.centroIndirizzo].filter(Boolean).join(', ') });
      icsAttachment = { filename: 'appuntamento.ics', content: Buffer.from(_ics).toString('base64'), contentType: 'text/calendar; charset=utf-8' };
    }
    replyTo       = appt.medicoEmail;
    medicoIdAudit = authCtx.medicoId;
    targetType    = 'appuntamento';
    targetId      = appt_id;

  } else if (tipo === 'notifica_prenotazione_coop') {
    const appt = await lookupAppt(body.appt_id, null, supabaseUrl, serviceKey);
    if (!appt.ok) return res.status(appt.status).json({ error: appt.error });
    if (!appt.notificaNuovaPrenotazione) {
      return res.status(200).json({ ok: true, skipped: 'notifiche disabilitate dal medico' });
    }
    if (!appt.medicoEmail) {
      return res.status(200).json({ ok: true, skipped: 'medico senza email' });
    }
    const dataFmt = formatDateIt(appt.data);
    to            = appt.medicoEmail;
    subject       = `Nuova prenotazione — ${appt.pazienteNome}, ${dataFmt}`;
    html          = buildHtmlNotificaMedicoCoop({ paziente_nome: esc(appt.pazienteNome), data_fmt: esc(dataFmt), ora: esc(appt.ora), tipo_visita: esc(appt.tipoVisita), medico_nome: esc(appt.medicoNome), centro_nome: esc(appt.centroNome) });
    medicoIdAudit = appt.apptMedicoId;
    targetType    = 'appuntamento';
    targetId      = body.appt_id;

  } else if (tipo === 'conferma_prenotazione_segreteria') {
    // ricevuta alla segreteria della cooperativa: destinatario derivato
    // interamente server-side (appt -> centro -> cooperativa -> segreteria
    // attiva -> email dall'admin API), mai dal client.
    const appt = await lookupAppt(body.appt_id, null, supabaseUrl, serviceKey);
    if (!appt.ok) return res.status(appt.status).json({ error: appt.error });
    const srvH = { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` };
    const rowRes = await fetch(`${supabaseUrl}/rest/v1/appuntamenti?id=eq.${encodeURIComponent(body.appt_id)}&select=centro_id,centri(cooperativa_id)`, { headers: srvH }).catch(() => null);
    const row = (rowRes && rowRes.ok) ? (await rowRes.json().catch(() => []))?.[0] : null;
    const coopId = row?.centri?.cooperativa_id;
    if (!coopId) return res.status(200).json({ ok: true, skipped: 'appuntamento non di cooperativa' });
    const segRes = await fetch(`${supabaseUrl}/rest/v1/segreterie?cooperativa_id=eq.${encodeURIComponent(coopId)}&stato=eq.attiva&select=user_id&limit=1`, { headers: srvH }).catch(() => null);
    const segRow = (segRes && segRes.ok) ? (await segRes.json().catch(() => []))?.[0] : null;
    if (!segRow?.user_id) return res.status(200).json({ ok: true, skipped: 'segreteria non trovata' });
    const uRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(segRow.user_id)}`, { headers: srvH }).catch(() => null);
    const uRow = (uRes && uRes.ok) ? await uRes.json().catch(() => null) : null;
    const segEmail = uRow?.email;
    if (!segEmail) return res.status(200).json({ ok: true, skipped: 'segreteria senza email' });
    const dataFmtS = formatDateIt(appt.data);
    to            = segEmail;
    subject       = `Prenotazione registrata — ${appt.pazienteNome}, ${dataFmtS}`;
    html          = buildHtmlRicevutaSegreteria({ paziente_nome: esc(appt.pazienteNome), data_fmt: esc(dataFmtS), ora: esc(appt.ora), tipo_visita: esc(appt.tipoVisita), medico_nome: esc(appt.medicoNome), centro_nome: esc(appt.centroNome) });
    medicoIdAudit = appt.apptMedicoId;
    targetType    = 'appuntamento';
    targetId      = body.appt_id;

  } else if (tipo === 'notifica_medico_prenotazione' || tipo === 'notifica_medico_cancellazione') {
    const appt = await lookupAppt(body.appt_id, null, supabaseUrl, serviceKey);
    if (!appt.ok) return res.status(appt.status).json({ error: appt.error });
    const flag = tipo === 'notifica_medico_prenotazione' ? appt.mailMedicoPrenotazione : appt.mailMedicoCancellazione;
    if (!flag) return res.status(200).json({ ok: true, skipped: 'notifica disabilitata dal medico' });
    if (!appt.medicoEmail) return res.status(200).json({ ok: true, skipped: 'medico senza email' });
    const dataFmtM = formatDateIt(appt.data);
    const eventoM = tipo === 'notifica_medico_prenotazione' ? 'prenotazione' : 'cancellazione';
    to            = appt.medicoEmail;
    subject       = (eventoM === 'prenotazione' ? 'Nuova prenotazione — ' : 'Prenotazione cancellata — ') + `${appt.pazienteNome}, ${dataFmtM}`;
    html          = buildHtmlNotificaMedicoEvento({ evento: eventoM, medico_nome: esc(appt.medicoNome), paziente_nome: esc(appt.pazienteNome), data_fmt: esc(dataFmtM), ora: esc(appt.ora), tipo_visita: esc(appt.tipoVisita), centro_nome: esc(appt.centroNome) });
    medicoIdAudit = appt.apptMedicoId;
    targetType    = 'appuntamento';
    targetId      = body.appt_id;

  } else if (tipo === 'notifica_medico_appuntamento') {
    const appt = await lookupAppt(body.appt_id, null, supabaseUrl, serviceKey);
    if (!appt.ok) return res.status(appt.status).json({ error: appt.error });
    if (String(appt.apptMedicoId) !== String(authCtx.medicoId)) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (!appt.mailMedicoAppuntamento) return res.status(200).json({ ok: true, skipped: 'notifica disabilitata dal medico' });
    if (!appt.medicoEmail) return res.status(200).json({ ok: true, skipped: 'medico senza email' });
    const dataFmtA = formatDateIt(appt.data);
    to            = appt.medicoEmail;
    subject       = `Appuntamento registrato — ${appt.pazienteNome}, ${dataFmtA}`;
    html          = buildHtmlNotificaMedicoEvento({ evento: 'appuntamento', medico_nome: esc(appt.medicoNome), paziente_nome: esc(appt.pazienteNome), data_fmt: esc(dataFmtA), ora: esc(appt.ora), tipo_visita: esc(appt.tipoVisita), centro_nome: esc(appt.centroNome) });
    medicoIdAudit = appt.apptMedicoId;
    targetType    = 'appuntamento';
    targetId      = body.appt_id;

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
    const ch = await lookupChiusura(chiusura_id, centro_id, authCtx.medicoId, supabaseUrl, serviceKey);
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
    if (icsAttachment) payload.attachments = [icsAttachment];
    const { data: sendData, error: sendErr } = await resend.emails.send(payload);
    if (sendErr) {
      console.error('[send-email] resend error:', sendErr.message, { tipo, to: redactEmail(to) });
      return res.status(500).json({ error: 'Errore invio email' });
    }
    resendId = sendData?.id;
    console.log('[send-email] email inviata', { tipo, to: redactEmail(to), resend_id: resendId });
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
  const riprenota = bookingLink
    ? `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 20px;">Per riprenotare la visita, pu&ograve; contattare direttamente il centro oppure consultare i nuovi orari disponibili:</p>` + ctaButton(bookingLink, 'Prenota un nuovo appuntamento')
    : `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 28px;">Per riprenotare la visita, pu&ograve; contattare direttamente il centro.</p>`;
  const body =
    emailTitle('Appuntamento annullato') +
    `<p style="font-size:16px;color:#1a1a1a;margin:0 0 20px;">Gentile <strong>${paziente_nome}</strong>,</p>` +
    `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 28px;">la informiamo che l&apos;appuntamento del <strong>${dataFmt}</strong> alle ore <strong>${ora}</strong> presso <strong>${centro_nome}</strong> con <strong>${medArt(medico_nome)}</strong> &egrave; stato annullato.</p>` +
    riprenota +
    `<p style="font-size:13px;color:#555;line-height:1.6;margin:0;">Ci scusiamo per l&apos;inconveniente.<br><br>Cordiali saluti.</p>`;
  return emailShell(body);
}

// Articolo + titolo del medico: "il Dr." / "la Dr.ssa" / "del" / "della". Fallback 'il medico'.
function _medFem(n){ return /ssa/i.test((n || '').split(' ')[0]); }
function medArt(n){ if(!n || n === 'il medico') return 'il medico'; return (_medFem(n) ? 'la ' : 'il ') + n; }
function medArtMai(n){ const s = medArt(n); return s.charAt(0).toUpperCase() + s.slice(1); }
function medDi(n){ if(!n || n === 'il medico') return 'del medico'; return (_medFem(n) ? 'della ' : 'del ') + n; }

function buildIcsSummary(tipoVisita, medicoNome) {
  const tv = (tipoVisita || '').trim();
  const mn = (medicoNome || '').trim();
  if (tv && mn) return `${tv} — ${mn}`;
  if (mn) return `Visita medica — ${mn}`;
  return tv || 'Visita medica';
}

function buildCalendarUrls({ data_raw, ora, centro_nome, centro_indirizzo, appt_id, codice_cancellazione, ics_host }) {
  if (!data_raw || !ora) return { googleUrl: '', icsUrl: '' };
  const [y, m, d] = data_raw.split('-');
  const [hh, mm] = ora.split(':');
  const dtStart = `${y}${m}${d}T${hh}${mm}00`;
  const totalMin = parseInt(hh, 10) * 60 + parseInt(mm, 10) + 30;
  const endH = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const endM = String(totalMin % 60).padStart(2, '0');
  const dtEnd = `${y}${m}${d}T${endH}${endM}00`;
  const loc = [centro_nome, centro_indirizzo].filter(Boolean).join(', ');
  const googleUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent('Visita medica')}&dates=${dtStart}/${dtEnd}&ctz=Europe%2FRome&location=${encodeURIComponent(loc)}`;
  const icsUrl = (appt_id && codice_cancellazione)
    ? `https://${ics_host}/api/ics?id=${encodeURIComponent(appt_id)}&token=${encodeURIComponent(codice_cancellazione)}`
    : '';
  return { googleUrl, icsUrl };
}

function buildHtml({ paziente_nome, medico_nome, centro_nome, dataFmt, ora, tipo_visita, codice_cancellazione, data_raw, appt_id, centro_indirizzo, ics_host }) {
  const cancelUrl = 'https://delphi-med.com/?cancel=' + encodeURIComponent(codice_cancellazione);
  const { googleUrl, icsUrl } = buildCalendarUrls({ data_raw, ora, centro_nome, centro_indirizzo, appt_id, codice_cancellazione, ics_host });
  const btnStyle = 'display:inline-block;padding:8px 16px;background:#f1f6fd;border:1px solid #d3e3f4;border-radius:6px;text-decoration:none;color:#15487F;font-size:13px;font-weight:500;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;';
  const calSection = googleUrl
    ? `<div style="margin-bottom:28px;">` +
      `<p style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#888;margin:0 0 10px;">Aggiungi al calendario</p>` +
      `<a href="${googleUrl}" target="_blank" style="${btnStyle}">Google Calendar</a>` +
      (icsUrl ? `&#160;&#160;<a href="${icsUrl}" style="${btnStyle}">Apple&#8202;/&#8202;Outlook (.ics)</a>` : '') +
      `<p style="font-size:12px;color:#888;margin:8px 0 0;">Il file <em>appuntamento.ics</em> &egrave; allegato a questa email.</p>` +
      `</div>`
    : '';
  const body =
    emailTitle('Appuntamento confermato') +
    `<p style="font-size:16px;color:#1a1a1a;margin:0 0 18px;">Gentile <strong>${paziente_nome}</strong>,</p>` +
    `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 28px;">La tua prenotazione con <strong>${medArt(medico_nome)}</strong> &egrave; confermata.<br>Di seguito il riepilogo del tuo appuntamento.</p>` +
    detailCard(
      detailRow('Centro medico', centro_nome) +
      detailRow('Data', dataFmt) +
      detailRow('Ora', ora) +
      detailRow('Tipo visita', tipo_visita, { last: true })
    ) +
    calSection +
    noteBox('<strong>Ricorda di portare</strong> la tua documentazione sanitaria: tessera sanitaria, referti e risultati di esami precedenti, e ogni altro documento rilevante per la visita.') +
    `<p style="font-size:13px;color:#555;line-height:1.6;text-align:center;margin:24px auto 12px;max-width:480px;">Se non puoi venire, ti chiediamo gentilmente di cancellare il prima possibile: lo slot torner&agrave; subito disponibile per un altro paziente che ne ha bisogno.</p>` +
    ctaButton(cancelUrl, 'Cancella l&rsquo;appuntamento');
  return emailShell(body);
}

function buildHtmlNotificaCentro({ evento, paziente_nome, data_fmt, ora, tipo_visita, medico_nome, centro_nome }) {
  const LABELS = { nuova_prenotazione: 'Nuova prenotazione', appuntamento_manuale: 'Nuovo appuntamento', cancellazione: 'Cancellazione appuntamento' };
  const INTRO  = {
    nuova_prenotazione: `&Egrave; appena arrivata una nuova prenotazione online per ${medArt(medico_nome)}. Vi giriamo i dettagli per la vostra agenda.`,
    appuntamento_manuale: `${medArtMai(medico_nome)} ha inserito un nuovo appuntamento. Di seguito i dettagli.`,
    cancellazione: `Vi segnaliamo la cancellazione di un appuntamento ${medDi(medico_nome)}: lo slot &egrave; di nuovo disponibile.`
  };
  const label = LABELS[evento] || evento;
  const intro = INTRO[evento] || `Vi inoltriamo un aggiornamento relativo all&apos;agenda ${medDi(medico_nome)}.`;
  const rows =
    detailRow('Paziente', paziente_nome) +
    detailRow('Medico', medico_nome) +
    detailRow('Data', data_fmt) +
    detailRow('Ora', ora, { last: !tipo_visita }) +
    (tipo_visita ? detailRow('Tipo visita', tipo_visita, { last: true }) : '');
  const body =
    emailTitle(label) +
    `<p style="margin:0 0 24px;color:#333;font-size:15px;line-height:1.55;">Gentile Segreteria,<br>${intro}</p>` +
    detailCard(rows) +
    `<p style="margin:0;color:#333;font-size:14px;line-height:1.55;">Grazie per la collaborazione.</p>`;
  return emailShell(body);
}

function buildHtmlNotificaMedicoEvento({ evento, medico_nome, paziente_nome, data_fmt, ora, tipo_visita, centro_nome }) {
  const TITOLI = { prenotazione: 'Nuova prenotazione online', cancellazione: 'Prenotazione cancellata dal paziente', appuntamento: 'Appuntamento registrato' };
  const INTRI = {
    prenotazione: 'un paziente ha prenotato una visita dalla Sua pagina pubblica. Di seguito i dettagli.',
    cancellazione: 'il paziente ha cancellato la propria prenotazione: lo slot &egrave; di nuovo disponibile in agenda.',
    appuntamento: 'ecco il riepilogo dell&apos;appuntamento che ha appena inserito, per i Suoi archivi.'
  };
  const rows =
    detailRow('Paziente', paziente_nome) +
    (centro_nome ? detailRow('Centro', centro_nome) : '') +
    detailRow('Data', data_fmt) +
    detailRow('Ora', ora, { last: !tipo_visita }) +
    (tipo_visita ? detailRow('Tipo visita', tipo_visita, { last: true }) : '');
  const body =
    emailTitle(TITOLI[evento] || 'Aggiornamento agenda') +
    `<p style="margin:0 0 24px;color:#333;font-size:15px;line-height:1.55;">Gentile ${medico_nome || 'Dottore'},<br>${INTRI[evento] || ''}</p>` +
    detailCard(rows) +
    `<p style="margin:0;color:#333;font-size:14px;line-height:1.55;">Puoi gestire queste notifiche dalle Impostazioni del tuo profilo.</p>`;
  return emailShell(body);
}

function buildHtmlNotificaMedicoCoop({ medico_nome, paziente_nome, data_fmt, ora, tipo_visita, centro_nome }) {
  const rows =
    detailRow('Paziente', paziente_nome) +
    detailRow('Sede', centro_nome) +
    detailRow('Data', data_fmt) +
    detailRow('Ora', ora, { last: !tipo_visita }) +
    (tipo_visita ? detailRow('Tipo visita', tipo_visita, { last: true }) : '');
  const body =
    emailTitle('Nuova prenotazione dalla segreteria') +
    `<p style="margin:0 0 24px;color:#333;font-size:15px;line-height:1.55;">Gentile ${medico_nome || 'Dottore'},<br>la segreteria dell&apos;organizzazione ha registrato una nuova prenotazione per Lei. Di seguito i dettagli.</p>` +
    detailCard(rows) +
    `<p style="margin:0;color:#333;font-size:14px;line-height:1.55;">L&apos;appuntamento &egrave; gi&agrave; visibile nella Sua agenda Delphi~Med.</p>`;
  return emailShell(body);
}

function buildHtmlRicevutaSegreteria({ medico_nome, paziente_nome, data_fmt, ora, tipo_visita, centro_nome }) {
  const rows =
    detailRow('Paziente', paziente_nome) +
    detailRow('Medico', medico_nome) +
    detailRow('Sede', centro_nome) +
    detailRow('Data', data_fmt) +
    detailRow('Ora', ora, { last: !tipo_visita }) +
    (tipo_visita ? detailRow('Tipo visita', tipo_visita, { last: true }) : '');
  const body =
    emailTitle('Prenotazione registrata') +
    `<p style="margin:0 0 24px;color:#333;font-size:15px;line-height:1.55;">Gentile Segreteria,<br>la prenotazione che avete appena registrato &egrave; stata confermata e inserita nell&apos;agenda ${medDi(medico_nome)}. Questo &egrave; il riepilogo per i vostri registri.</p>` +
    detailCard(rows) +
    `<p style="margin:0;color:#333;font-size:14px;line-height:1.55;">Se il paziente ha fornito un&apos;email, ha ricevuto la conferma con il codice di cancellazione.</p>`;
  return emailShell(body);
}

function buildHtmlChiusura({ data_inizio_fmt, data_fine_fmt, etichetta, centro_nome, medico_nome }) {
  const periodo = data_inizio_fmt === data_fine_fmt
    ? `il <strong>${data_inizio_fmt}</strong>`
    : `dal <strong>${data_inizio_fmt}</strong> al <strong>${data_fine_fmt}</strong>`;
  const body =
    emailTitle('Chiusura studio programmata') +
    `<p style="font-size:15px;color:#1a1a1a;margin:0 0 20px;">Gentile <strong>${centro_nome}</strong>,</p>` +
    `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 24px;">il medico <strong>${medico_nome}</strong> ha programmato una chiusura dello studio${etichetta ? ` (<em>${etichetta}</em>)` : ''} ${periodo}.</p>` +
    noteBox('In questo periodo non verranno generati nuovi slot prenotabili. Gli appuntamenti gi&agrave; confermati restano in agenda.') +
    `<p style="font-size:13px;color:#888;margin:0;">Per informazioni contattare direttamente il medico.</p>`;
  return emailShell(body);
}

function buildHtmlAccountEliminazione({ medico_nome }) {
  const body =
    emailTitle('Eliminazione account programmata', { tone: 'danger' }) +
    `<p style="font-size:16px;color:#1a1a1a;margin:0 0 16px;">Gentile <strong>${medico_nome}</strong>,</p>` +
    `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 20px;">abbiamo ricevuto una richiesta di eliminazione del tuo account Delphi~Med. La procedura &egrave; stata avviata.</p>` +
    noteBox('Se non sei stato tu a richiedere l&rsquo;eliminazione, contatta immediatamente il supporto a <a href="mailto:support@delphi-med.com" style="color:#dc2626;">support@delphi-med.com</a>.', { tone: 'danger' }) +
    `<p style="font-size:13px;color:#888;margin:0;">Grazie per aver utilizzato Delphi~Med.</p>`;
  return emailShell(body);
}
