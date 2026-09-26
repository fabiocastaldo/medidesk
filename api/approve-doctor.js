import crypto from 'crypto';
import { Resend } from 'resend';
import { emailShell, emailTitle, detailCard, detailRow, noteBox, ctaButton } from '../lib/email-shell.js';

// ─────────────────────────────────────────────────────────────────────────────
// JWT HS256 minimal verify (no library, crypto nativo)
// Restituisce il payload se la firma è valida, altrimenti null.
// ─────────────────────────────────────────────────────────────────────────────
function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecodeToString(s) {
  // Reverse del base64url → base64 standard
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64').toString('utf8');
}

function verifyJwtHS256(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  // Ricalcola la firma attesa
  const data = `${h}.${p}`;
  const expectedSig = base64urlEncode(
    crypto.createHmac('sha256', secret).update(data).digest()
  );

  // Confronto a tempo costante per evitare timing attack
  if (s.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expectedSig))) return null;

  // Firma valida → decodifica payload
  try {
    const payload = JSON.parse(base64urlDecodeToString(p));
    return payload;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlPage(title, message, isSuccess) {
  const icon = isSuccess ? '&#9989;' : '&#10060;';
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} — Delphi~Med</title>
  <style>
    body{margin:0;padding:0;background:#f0f4f4;font-family:'Helvetica Neue',Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#fff;border-radius:16px;box-shadow:0 4px 32px rgba(0,0,0,.1);padding:48px 40px;max-width:480px;width:100%;text-align:center}
    .logo{font-size:13px;font-weight:700;letter-spacing:.5px;color:#0D9488;text-transform:uppercase;margin-bottom:32px}
    .icon{font-size:48px;margin-bottom:16px}
    h1{margin:0 0 12px;font-size:22px;color:#1a1a1a}
    p{margin:0;font-size:15px;color:#555;line-height:1.6}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Delphi~Med</div>
    <div class="icon">${icon}</div>
    <h1>${esc(title)}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Template email di approvazione al medico
// ─────────────────────────────────────────────────────────────────────────────
function buildApprovalEmail({ nome, cognome }) {
  const nomeCompleto = esc([nome, cognome].filter(Boolean).join(' ')) || 'Dottore/ssa';
  const body =
    emailTitle('Account approvato') +
    `<p style="font-size:16px;color:#1a1a1a;margin:0 0 16px;">Gentile <strong>${nomeCompleto}</strong>,</p>` +
    `<p style="font-size:15px;color:#444;line-height:1.7;margin:0 0 28px;">Il tuo account Delphi~Med &egrave; stato approvato.<br>Puoi ora accedere alla piattaforma e iniziare a gestire il tuo studio.</p>` +
    ctaButton('https://delphi-med.com', 'Accedi a Delphi~Med') +
    `<p style="font-size:13px;color:#888;text-align:center;margin:0;">Oppure copia il link: <a href="https://delphi-med.com" style="color:#15487F;">https://delphi-med.com</a></p>`;
  return emailShell(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Approvazione verificata (s55, 26/09/2026, piano privacy riga 27)
// GET  ?token=…  → pagina di verifica (nessuna modifica di stato: i controlli automatici dei
//                  link nelle caselle email non possono più approvare nessuno).
// POST token + esito della verifica sull'Albo unico FNOMCeO (+ PEC da INI-PEC facoltativa)
//      → esito positivo: token consumato, medico approvato, traccia in audit_log con fonte,
//        esito, casella del gestore e ora; avviso alla PEC se indicata; email di benvenuto.
//      → esito negativo: traccia in audit_log, il medico resta in attesa, il token resta valido.
// ─────────────────────────────────────────────────────────────────────────────
const ALBO_URL = 'https://albounico.fnomceo.it/';
const INIPEC_URL = 'https://www.inipec.gov.it/';
// Il link di verifica arriva solo a questa casella (register-doctor): chi lo usa è il suo titolare.
// Nessun nome digitato a mano: la traccia registra la casella a cui il link è stato consegnato.
const CASELLA_GESTORE = 'fb.castaldo@gmail.com';
const isEmail = (x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) && x.length <= 254;

function paginaVerifica(token, m, msg) {
  const r = (k, v) => `<tr><th>${k}</th><td>${esc(v || '—')}</td></tr>`;
  return `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Verifica medico — Delphi~Med</title>
<style>
body{margin:0;background:#f0f4f4;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a1a1a}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 32px rgba(0,0,0,.1);padding:32px;max-width:640px;margin:32px auto}
.logo{font-size:13px;font-weight:700;letter-spacing:.5px;color:#0D9488;text-transform:uppercase;margin-bottom:18px}
h1{font-size:21px;margin:0 0 16px}h2{font-size:15px;margin:24px 0 8px}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;color:#666;font-weight:500;padding:6px 8px 6px 0;width:42%;vertical-align:top}td{padding:6px 0}
p,li{font-size:14px;line-height:1.6;color:#444}a{color:#15487F}
label{display:block;font-size:14px;margin:10px 0 4px}input[type=text],input[type=email]{width:100%;box-sizing:border-box;padding:9px;border:1px solid #ccd;border-radius:8px;font-size:14px}
.radio{display:flex;gap:8px;align-items:flex-start;margin:6px 0;font-size:14px}.radio input{margin-top:3px}
button{margin-top:22px;width:100%;padding:12px;border:0;border-radius:10px;background:#0B2B4D;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.msg{background:#fdecea;color:#c0392b;padding:10px 12px;border-radius:8px;font-size:14px;margin-bottom:12px}
.nota{font-size:12px;color:#777}
</style></head><body><div class="card">
<div class="logo">Delphi~Med</div><h1>Verifica e approvazione del medico</h1>
${msg ? `<div class="msg">${esc(msg)}</div>` : ''}
<table>${r('Nome e cognome', [m.nome, m.cognome].filter(Boolean).join(' '))}${r('Email (verificata con codice)', m.email)}${r('Telefono', m.telefono_registrazione)}${r('N° iscrizione dichiarato', m.numero_iscrizione_ordine)}${r('Ordine (provincia) dichiarato', m.provincia_ordine)}${r('Specializzazione', m.specializzazione)}${r('Registrato il', m.created_at ? new Date(m.created_at).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }) : '')}</table>
<h2>1. Albo unico FNOMCeO</h2>
<p>Apri <a href="${ALBO_URL}" target="_blank" rel="noopener noreferrer">albounico.fnomceo.it</a>, cerca <strong>${esc([m.nome, m.cognome].filter(Boolean).join(' '))}</strong> e controlla che nome, cognome e Ordine coincidano.</p>
<form method="POST" action="/api/approve-doctor">
<input type="hidden" name="token" value="${esc(token)}">
<div class="radio"><input type="radio" id="e1" name="esito" value="trovato" required><label for="e1" style="margin:0">Iscritto all'albo: nome, cognome e Ordine coincidono</label></div>
<div class="radio"><input type="radio" id="e2" name="esito" value="non_trovato"><label for="e2" style="margin:0">Non trovato o dati diversi (il medico resta in attesa)</label></div>
<label for="ord">Ordine trovato sull'albo <span class="nota">(precompilato con il dichiarato: correggi se diverso)</span></label><input type="text" id="ord" name="ordine" maxlength="80" value="${esc(m.provincia_ordine)}">
<h2>2. Indice INI-PEC (facoltativo)</h2>
<p>Su <a href="${INIPEC_URL}" target="_blank" rel="noopener noreferrer">inipec.gov.it</a> → «Professionisti», cerca il medico: riporta il numero d'iscrizione e la PEC. All'attivazione gli manderemo un avviso alla PEC. Se non c'è, lascia vuoto.</p>
<label for="num">Numero d'iscrizione trovato su INI-PEC <span class="nota">(precompilato con il dichiarato: correggi se diverso)</span></label><input type="text" id="num" name="numero" maxlength="50" value="${esc(m.numero_iscrizione_ordine)}">
<label for="pec">PEC trovata</label><input type="email" id="pec" name="pec" maxlength="254" placeholder="nome.cognome@pec.omceo…">
<p class="nota">Data, ora e casella a cui è stato consegnato questo link (${CASELLA_GESTORE}) le registra il sistema. La verifica resta nella traccia di audit.</p>
<button type="submit">Registra la verifica</button>
</form></div></body></html>`;
}

function buildAvvisoPec({ nome, cognome, numero, ordine, email }) {
  const n = esc([nome, cognome].filter(Boolean).join(' '));
  return emailShell(
    emailTitle('Attivazione di un account Delphi~Med a tuo nome') +
    `<p style="font-size:15px;color:#333;line-height:1.6;margin:0 0 16px;">Ti scriviamo alla PEC registrata presso il tuo Ordine perch&eacute; &egrave; stato attivato un account Delphi~Med, gestionale per medici specialisti, a nome di <strong>${n}</strong> (iscrizione n. ${esc(numero)}, Ordine di ${esc(ordine)}), con l&rsquo;email <strong>${esc(email)}</strong>.</p>` +
    `<p style="font-size:15px;color:#333;line-height:1.6;margin:0 0 16px;">Se l&rsquo;hai aperto tu, non devi fare nulla. Se non sei stato tu, scrivi subito a <a href="mailto:privacy@delphi-med.com">privacy@delphi-med.com</a>: sospenderemo l&rsquo;account e verificheremo.</p>` +
    `<p style="font-size:13px;color:#777;line-height:1.6;margin:0;">Questo avviso fa parte della verifica dei medici che si registrano a Delphi~Med ed &egrave; descritto nell&rsquo;informativa privacy per i medici.</p>`
  );
}

async function leggiContesto(token, env) {
  const payload = verifyJwtHS256(token, env.approveSecret);
  if (!payload) return { err: [401, 'Token non valido', 'Il link di approvazione non è valido. Potrebbe essere stato manomesso.'] };
  const { user_id: userId, jti, exp } = payload;
  if (!userId || !jti || !exp) return { err: [401, 'Token non valido', 'Il link di approvazione non contiene tutti i dati richiesti.'] };
  if (exp < Math.floor(Date.now() / 1000)) return { err: [401, 'Link scaduto', 'Questo link di approvazione è scaduto. Richiedi al medico di registrarsi nuovamente.'] };
  const t = await fetch(`${env.base}/approve_tokens?jti=eq.${encodeURIComponent(jti)}&select=used_at`, { headers: env.headers });
  if (!t.ok) return { err: [500, 'Errore database', 'Impossibile validare il token. Riprova più tardi.'] };
  const tr = (await t.json().catch(() => []))[0];
  if (!tr) return { err: [401, 'Token non valido', 'Il link di approvazione non è riconosciuto.'] };
  if (tr.used_at) return { err: [409, 'Token già usato', 'Questo link di approvazione è già stato utilizzato in precedenza.'] };
  const mr = await fetch(`${env.base}/medici?user_id=eq.${encodeURIComponent(userId)}&select=id,email,nome,cognome,telefono_registrazione,numero_iscrizione_ordine,provincia_ordine,specializzazione,created_at,stato`, { headers: env.headers });
  if (!mr.ok) return { err: [500, 'Errore database', 'Impossibile leggere il medico.'] };
  const m = (await mr.json().catch(() => []))[0];
  if (!m) return { err: [404, 'Medico non trovato', 'Il medico associato a questo token non esiste più nel sistema.'] };
  if (m.stato !== 'in_attesa') return { err: [409, 'Già gestito', `Questo account non è in attesa di approvazione (stato: ${m.stato}).`] };
  return { userId, jti, m };
}

async function audit(env, medicoId, action, details) {
  const r = await fetch(`${env.base}/audit_log`, {
    method: 'POST', headers: { ...env.headers, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ medico_id: medicoId, action, target_type: 'medico', target_id: medicoId, details })
  });
  if (!r.ok) throw new Error(`audit ${r.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler principale
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  const approveSecret = process.env.APPROVE_TOKEN_SECRET;
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!supabaseUrl || !serviceKey || !approveSecret) {
    console.error('[approve-doctor] env vars mancanti');
    return res.status(500).send(htmlPage('Errore di configurazione', 'Configurazione server incompleta.', false));
  }
  const env = { approveSecret, base: `${supabaseUrl}/rest/v1`,
    headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' } };

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).send(htmlPage('Metodo non ammesso', 'Usa il link ricevuto via email.', false));
  }
  const body = req.method === 'POST' ? (req.body || {}) : {};
  const token = req.method === 'POST' ? body.token : req.query?.token;
  if (!token || typeof token !== 'string' || !token.trim()) {
    return res.status(400).send(htmlPage('Errore', 'Parametro token mancante o non valido.', false));
  }

  let ctx;
  try { ctx = await leggiContesto(token, env); }
  catch (e) {
    console.error('[approve-doctor] contesto:', e.message);
    return res.status(500).send(htmlPage('Errore di rete', 'Impossibile contattare il database.', false));
  }
  if (ctx.err) return res.status(ctx.err[0]).send(htmlPage(ctx.err[1], esc(ctx.err[2]), false));
  const { jti, m } = ctx;

  // GET: solo la pagina di verifica, nessuna modifica
  if (req.method === 'GET') return res.status(200).send(paginaVerifica(token, m));

  // POST: esito della verifica
  const esito = body.esito === 'trovato' ? 'trovato' : body.esito === 'non_trovato' ? 'non_trovato' : null;
  const numero = String(body.numero || '').trim().slice(0, 50);
  const ordine = String(body.ordine || '').trim().slice(0, 80);
  const pec = String(body.pec || '').trim().toLowerCase().slice(0, 254);
  if (!esito) return res.status(400).send(paginaVerifica(token, m, 'Indica l\'esito della verifica sull\'albo.'));
  if (esito === 'trovato' && !ordine) return res.status(400).send(paginaVerifica(token, m, 'Riporta l\'Ordine trovato sull\'albo.'));
  if (pec && !isEmail(pec)) return res.status(400).send(paginaVerifica(token, m, 'La PEC indicata non è un indirizzo valido.'));
  const positivo = esito === 'trovato';
  const verifica = { fonte: 'Albo unico FNOMCeO', url: ALBO_URL, esito, ordine_trovato: positivo ? (ordine || null) : null,
    ordine_dichiarato: m.provincia_ordine || null,
    fonte_numero_pec: positivo && (numero || pec) ? 'INI-PEC' : null, numero_trovato: positivo ? (numero || null) : null,
    numero_dichiarato: m.numero_iscrizione_ordine || null, pec_inipec: positivo ? (pec || null) : null,
    link_consegnato_a: CASELLA_GESTORE, verificato_at: new Date().toISOString() };

  if (esito === 'non_trovato') {
    try { await audit(env, m.id, 'verifica_qualifica_negativa', verifica); }
    catch (e) { console.error('[approve-doctor] audit negativo:', e.message); return res.status(500).send(htmlPage('Errore database', 'Verifica non registrata: riprova.', false)); }
    return res.status(200).send(htmlPage('Verifica registrata: non approvato',
      'L\'esito negativo è registrato. Il medico resta in attesa e il link resta valido se vuoi ripetere la verifica.', false));
  }

  // Esito positivo: prima la traccia (senza traccia niente approvazione), poi token e stato
  try { await audit(env, m.id, 'verifica_qualifica', verifica); }
  catch (e) { console.error('[approve-doctor] audit:', e.message); return res.status(500).send(htmlPage('Errore database', 'Verifica non registrata: il medico non è stato approvato. Riprova.', false)); }
  try {
    const mk = await fetch(`${env.base}/approve_tokens?jti=eq.${encodeURIComponent(jti)}&used_at=is.null&select=jti`, {
      method: 'PATCH', headers: { ...env.headers, 'Prefer': 'return=representation' }, body: JSON.stringify({ used_at: new Date().toISOString() })
    });
    if (!mk.ok) return res.status(500).send(htmlPage('Errore database', 'Impossibile validare il token. Riprova più tardi.', false));
    if (!(await mk.json().catch(() => [])).length) return res.status(409).send(htmlPage('Token già usato', 'Questo link di approvazione è già stato utilizzato in precedenza.', false));
    const pr = await fetch(`${env.base}/medici?id=eq.${m.id}&stato=eq.in_attesa&select=id`, {
      method: 'PATCH', headers: { ...env.headers, 'Prefer': 'return=representation' }, body: JSON.stringify({ stato: 'approvato' })
    });
    if (!pr.ok || !(await pr.json().catch(() => [])).length) {
      console.error('[approve-doctor] patch medici failed:', pr.status);
      return res.status(500).send(htmlPage('Errore database', 'Impossibile approvare il medico.', false));
    }
  } catch (e) {
    console.error('[approve-doctor] approvazione:', e.message);
    return res.status(500).send(htmlPage('Errore di rete', 'Impossibile contattare il database.', false));
  }

  // Avvisi (best-effort): PEC dall'indice, poi benvenuto al medico
  let pecEsito = pec ? 'non_inviato' : 'assente';
  if (resendApiKey) {
    const resend = new Resend(resendApiKey);
    if (pec) {
      try {
        const { error } = await resend.emails.send({ from: 'noreply@delphi-med.com', to: [pec],
          subject: 'Attivazione di un account Delphi~Med a tuo nome',
          html: buildAvvisoPec({ nome: m.nome, cognome: m.cognome, numero, ordine, email: m.email }) });
        pecEsito = error ? 'errore_invio' : 'inviato';
        if (error) console.error('[approve-doctor] avviso PEC:', error.message);
      } catch (e) { pecEsito = 'errore_invio'; console.error('[approve-doctor] avviso PEC:', e.message); }
    }
    if (m.email) {
      try {
        const { error } = await resend.emails.send({ from: 'noreply@delphi-med.com', to: [m.email],
          subject: 'Account approvato — Delphi~Med', html: buildApprovalEmail({ nome: m.nome, cognome: m.cognome }) });
        if (error) console.error('[approve-doctor] resend send error:', error.message);
      } catch (e) { console.error('[approve-doctor] resend exception:', e.message); }
    }
  }
  try { await audit(env, m.id, 'medico_approvato', { verifica: 'verifica_qualifica', avviso_pec: pecEsito, link_consegnato_a: CASELLA_GESTORE }); }
  catch (e) { console.error('[approve-doctor] audit approvazione:', e.message); }

  const pecTxt = { inviato: 'Avviso inviato alla PEC indicata.', errore_invio: 'L\'avviso alla PEC non è partito: vedi i log.', assente: 'Nessuna PEC indicata.' }[pecEsito] || '';
  return res.status(200).send(htmlPage('Medico approvato',
    `Verifica registrata e medico approvato: può ora accedere a Delphi~Med. ${esc(pecTxt)}`, true));
}
