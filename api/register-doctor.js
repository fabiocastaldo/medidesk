import crypto from 'crypto';
import { Resend } from 'resend';
import { emailShell, emailTitle, detailCard, detailRow, noteBox, ctaButton } from '../lib/email-shell.js';
import { creaSfida, verificaCodice, nonceSfida, normEmail } from '../lib/verifica-email.js';

// ─────────────────────────────────────────────────────────────────────────────
// Registrazione verificata (s55, 26/09/2026, piano privacy riga 27):
//   1. POST { azione:'codice', email } → codice di 6 cifre via email + "sfida" firmata (scopo
//      'reg-medico-v1': un codice di prenotazione non vale qui). Nessuna riga in DB.
//   2. POST con tutti i dati + telefono (obbligatorio) + sfida + codice → solo con codice valido
//      nascono utente e profilo e parte la mail di approvazione al gestore.
// Consenso commerciale: facoltativo, mai preselezionato, non condiziona la registrazione; il testo
// sotto è quello mostrato nel form (stesso testo carattere per carattere) e il suo hash va
// nell'evidenza. Si revoca da Impostazioni (sezione Comunicazioni commerciali).
// ─────────────────────────────────────────────────────────────────────────────
const SCOPO_REG = 'reg-medico-v1';
const CONSENSO_COMMERCIALE = {
  versione: 'cc-2026-09-26',
  testo: 'Acconsento a ricevere da Delphi~Med comunicazioni commerciali e informative su nuove funzioni, offerte e iniziative del servizio, via email o telefono. Il consenso è facoltativo, non influisce sulla registrazione e posso revocarlo in ogni momento da Impostazioni o scrivendo a privacy@delphi-med.com.'
};
const hashTesto = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
// Telefono: cifre con eventuale + iniziale, 8-15 cifre dopo aver tolto spazi, punti, trattini e parentesi.
function normTelefono(t) {
  const s = String(t || '').replace(/[\s.\-()\/]/g, '');
  return /^\+?[0-9]{8,15}$/.test(s) ? s : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Testi legali canonici: versione + SHA-256 del file pubblicato.
// INVARIANTE: ogni modifica a dpa.html o termini-di-servizio.html richiede
// l'aggiornamento di versione e hash qui (sha256sum <file>).
// ─────────────────────────────────────────────────────────────────────────────
const LEGAL_DOCS = {
  tos: { versione: 'tos-0.2', hash: '3a26b7320f3f8d5ef170b756743711458cd023487ee7e3b64461ba53e5c0a8c2' },
  dpa: { versione: 'dpa-0.2', hash: '036b2632e9a7d091b48066dd49799b4473efdb268f0be9946af9c55e0444bffb' }
};

// ─────────────────────────────────────────────────────────────────────────────
// Rate limit: 5 registrazioni/ora per IP (anti-spam abuse), contatore DB condiviso
// fra le istanze (RPC check_rate_limit, chiave 'ip:<ip>'); fail-closed se il DB non risponde (26/09/2026).
// ─────────────────────────────────────────────────────────────────────────────
const REG_RATE_LIMIT = 5;
const REG_RATE_WINDOW_S = 3600;

async function checkSupabaseRateLimit(ip, endpoint, max, windowSeconds) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return false; // fail-closed
  try {
    const res = await fetch(`${url}/rest/v1/rpc/check_rate_limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ p_endpoint: endpoint, p_ip: ip, p_max_count: max, p_window_seconds: windowSeconds })
    });
    if (!res.ok) return false; // fail-closed: contatore non disponibile = richiesta respinta
    return (await res.json()) === true;
  } catch { return false; } // fail-closed (piano privacy riga 67)
}

// ─────────────────────────────────────────────────────────────────────────────
// JWT HS256 minimal sign (no library, crypto nativo)
// Payload: { user_id, jti, exp }
// ─────────────────────────────────────────────────────────────────────────────
function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwtHS256(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const h = base64urlEncode(JSON.stringify(header));
  const p = base64urlEncode(JSON.stringify(payload));
  const data = `${h}.${p}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest();
  const s = base64urlEncode(sig);
  return `${data}.${s}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validazione input (specchio della validazione frontend, ma server-authoritative)
// ─────────────────────────────────────────────────────────────────────────────
function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

function isValidPassword(s) {
  if (typeof s !== 'string' || s.length < 8 || s.length > 200) return false;
  if (!/[A-Z]/.test(s)) return false;
  if (!/[a-z]/.test(s)) return false;
  if (!/[0-9]/.test(s)) return false;
  if (!/[!@#$%^&*()\-_=+[\]{};:'"\\|,.<>/?`~]/.test(s)) return false;
  return true;
}

function isNonEmptyString(s, maxLen = 200) {
  return typeof s === 'string' && s.trim().length > 0 && s.length <= maxLen;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler principale
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verifica env vars
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  const approveSecret = process.env.APPROVE_TOKEN_SECRET;
  const resendApiKey = process.env.RESEND_API_KEY;
  const codiceSecret = process.env.CONSENSO_TOKEN_SECRET;
  if (!supabaseUrl || !serviceKey || !approveSecret || !resendApiKey || !codiceSecret) {
    console.error('[register-doctor] env vars mancanti');
    return res.status(500).json({ error: 'Configurazione server incompleta' });
  }

  // Passo 1: invio del codice di verifica (limiti propri, prima del limite sulle registrazioni)
  if ((req.body || {}).azione === 'codice') {
    const emailC = normEmail((req.body || {}).email).slice(0, 254);
    if (!isValidEmail(emailC)) return res.status(400).json({ error: 'Email non valida' });
    const ipC = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const eh = crypto.createHash('sha256').update(emailC).digest('hex').slice(0, 24);
    if (!(await checkSupabaseRateLimit(`ip:${ipC}`, 'register-codice', 10, 3600)) ||
        !(await checkSupabaseRateLimit(`e:${eh}`, 'register-codice', 5, 3600))) {
      return res.status(429).json({ error: 'Troppe richieste di codice. Riprova tra qualche minuto.' });
    }
    const { codice, sfida } = creaSfida(codiceSecret, emailC, SCOPO_REG);
    const htmlC = emailShell(
      emailTitle('Conferma il tuo indirizzo email') +
      `<p style="font-size:15px;color:#333;line-height:1.6;margin:0 0 20px;">Usa questo codice per completare la registrazione a Delphi~Med:</p>` +
      `<div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0B2B4D;text-align:center;margin:0 0 20px;">${codice}</div>` +
      `<p style="font-size:13px;color:#555;line-height:1.6;margin:0;">Il codice vale 10 minuti. Se non hai chiesto tu di registrarti, ignora questa email: nessun account verr&agrave; creato.</p>`
    );
    try {
      const { error } = await new Resend(resendApiKey).emails.send({
        from: 'noreply@delphi-med.com', to: [emailC],
        subject: `${codice} è il tuo codice di registrazione Delphi~Med`, html: htmlC
      });
      if (error) { console.error('[register-doctor] codice resend:', error.message); return res.status(502).json({ error: 'Invio del codice non riuscito, riprova' }); }
    } catch (e) {
      console.error('[register-doctor] codice resend:', e.message);
      return res.status(502).json({ error: 'Invio del codice non riuscito, riprova' });
    }
    return res.status(200).json({ ok: true, sfida });
  }

  // Rate limit per IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             req.socket?.remoteAddress || 'unknown';
  if (!(await checkSupabaseRateLimit(`ip:${ip}`, 'register-doctor', REG_RATE_LIMIT, REG_RATE_WINDOW_S))) {
    return res.status(429).json({ error: 'Troppi tentativi di registrazione. Riprova tra un\'ora.' });
  }

  // Estrazione e validazione input
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const nome = String(body.nome || '').trim();
  const cognome = String(body.cognome || '').trim();
  const ordineNumero = String(body.ordineNumero || '').trim();
  const ordineProvincia = String(body.ordineProvincia || '').trim();
  const specializzazione = String(body.specializzazione || '').trim();
  const accettaTos = body.accettaTos === true;
  const accettaDpa = body.accettaDpa === true;
  const telefono = normTelefono(body.telefono);
  const consensoCommerciale = body.consensoCommerciale === true;
  const sfida = typeof body.sfida === 'string' ? body.sfida : '';
  const codice = String(body.codice || '');

  if (!accettaTos || !accettaDpa) {
    return res.status(400).json({ error: 'Per creare l\'account devi accettare i Termini di servizio e l\'Accordo sul trattamento dei dati (DPA)' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Email non valida' });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ error: 'La password non soddisfa tutti i criteri richiesti' });
  }
  if (!isNonEmptyString(nome, 100) || !isNonEmptyString(cognome, 100)) {
    return res.status(400).json({ error: 'Nome e cognome obbligatori' });
  }
  if (!isNonEmptyString(ordineNumero, 50) || !isNonEmptyString(ordineProvincia, 50)) {
    return res.status(400).json({ error: 'Dati ordine obbligatori' });
  }
  if (!isNonEmptyString(specializzazione, 200)) {
    return res.status(400).json({ error: 'Specializzazione obbligatoria' });
  }
  if (!telefono) {
    return res.status(400).json({ error: 'Numero di telefono obbligatorio (solo cifre, eventuale prefisso internazionale)' });
  }
  // Codice di verifica dell'email: tentativi limitati per sfida, poi verifica della firma
  const nonce = nonceSfida(sfida);
  if (!nonce) return res.status(400).json({ error: 'Richiedi il codice di verifica', motivo: 'sfida_non_valida' });
  if (!(await checkSupabaseRateLimit(`n:${nonce}`, 'register-tentativi', 5, 900))) {
    return res.status(429).json({ error: 'Troppi tentativi con questo codice. Richiedine uno nuovo.', motivo: 'tentativi' });
  }
  const vc = verificaCodice(codiceSecret, sfida, codice, email, SCOPO_REG);
  if (!vc.ok) {
    const msg = { codice_errato: 'Codice non corretto', codice_scaduto: 'Codice scaduto: richiedine uno nuovo',
                  email_diversa: 'L\'email è cambiata dopo l\'invio del codice: richiedine uno nuovo',
                  sfida_non_valida: 'Richiedi il codice di verifica' }[vc.motivo] || 'Codice non valido';
    return res.status(400).json({ error: msg, motivo: vc.motivo });
  }

  const base = `${supabaseUrl}/rest/v1`;
  const authBase = `${supabaseUrl}/auth/v1`;
  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 1: crea utente in Supabase Auth (email_confirm: true: l'email è già verificata col codice)
  // ───────────────────────────────────────────────────────────────────────────
  let userId;
  try {
    const createUserRes = await fetch(`${authBase}/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password, email_confirm: true })
    });
    const userData = await createUserRes.json().catch(() => ({}));

    if (!createUserRes.ok) {
      // Email già registrata → 422 da Supabase
      const errMsg = userData.msg || userData.error || userData.message || '';
      if (createUserRes.status === 422 || /already|registered|exists/i.test(errMsg)) {
        return res.status(409).json({ error: 'Email già registrata' });
      }
      console.error('[register-doctor] createUser failed:', createUserRes.status, errMsg);
      return res.status(500).json({ error: 'Errore durante la creazione dell\'account' });
    }

    userId = userData.id;
    if (!userId) {
      console.error('[register-doctor] createUser ok ma nessun id');
      return res.status(500).json({ error: 'Errore durante la creazione dell\'account' });
    }
  } catch (e) {
    console.error('[register-doctor] createUser exception:', e.message);
    return res.status(500).json({ error: 'Errore di rete' });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 2: INSERT su tabella medici
  // ───────────────────────────────────────────────────────────────────────────
  let medicoId;
  try {
    const insertRes = await fetch(`${base}/medici`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        user_id: userId,
        email,
        nome,
        cognome,
        numero_iscrizione_ordine: ordineNumero,
        provincia_ordine: ordineProvincia,
        specializzazione,
        telefono_registrazione: telefono,
        consenso_commerciale: consensoCommerciale,
        consenso_commerciale_at: consensoCommerciale ? new Date().toISOString() : null,
        stato: 'in_attesa'
      })
    });
    if (!insertRes.ok) {
      const errText = await insertRes.text().catch(() => '');
      console.error('[register-doctor] insert medici failed:', insertRes.status, errText);
      // Rollback: cancella l'utente Auth appena creato
      await fetch(`${authBase}/admin/users/${userId}`, { method: 'DELETE', headers })
        .catch(e => console.error('[register-doctor] rollback delete user failed:', e.message));
      return res.status(500).json({ error: 'Errore durante la creazione del profilo medico' });
    }
    const rows = await insertRes.json().catch(() => []);
    medicoId = Array.isArray(rows) ? rows[0]?.id : rows?.id;
  } catch (e) {
    console.error('[register-doctor] insert medici exception:', e.message);
    return res.status(500).json({ error: 'Errore di rete' });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 2-bis: evidenza delle accettazioni legali (bloccante, con rollback).
  // Una riga per documento: id medico, email, versione, hash del testo, timestamp.
  // ───────────────────────────────────────────────────────────────────────────
  try {
    const accRes = await fetch(`${base}/accettazioni_legali`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify([
        { medico_id: medicoId, email, documento: 'tos', versione: LEGAL_DOCS.tos.versione, hash_testo: LEGAL_DOCS.tos.hash },
        { medico_id: medicoId, email, documento: 'dpa', versione: LEGAL_DOCS.dpa.versione, hash_testo: LEGAL_DOCS.dpa.hash },
        ...(consensoCommerciale ? [{ medico_id: medicoId, email, documento: 'consenso_commerciale',
            versione: CONSENSO_COMMERCIALE.versione, hash_testo: hashTesto(CONSENSO_COMMERCIALE.testo) }] : [])
      ])
    });
    const accRows = accRes.ok ? await accRes.json().catch(() => []) : [];
    const attese = consensoCommerciale ? 3 : 2;
    if (!accRes.ok || !Array.isArray(accRows) || accRows.length !== attese) {
      const errText = !accRes.ok ? await accRes.text().catch(() => '') : `rows=${accRows.length}`;
      console.error('[register-doctor] insert accettazioni_legali failed:', accRes.status, errText);
      // Rollback: senza evidenza dell'accettazione l'account non nasce
      await fetch(`${base}/medici?id=eq.${medicoId}`, { method: 'DELETE', headers })
        .catch(e => console.error('[register-doctor] rollback delete medico failed:', e.message));
      await fetch(`${authBase}/admin/users/${userId}`, { method: 'DELETE', headers })
        .catch(e => console.error('[register-doctor] rollback delete user failed:', e.message));
      return res.status(500).json({ error: 'Errore durante la registrazione dell\'accettazione. Riprova.' });
    }
  } catch (e) {
    console.error('[register-doctor] insert accettazioni_legali exception:', e.message);
    await fetch(`${base}/medici?id=eq.${medicoId}`, { method: 'DELETE', headers })
      .catch(err => console.error('[register-doctor] rollback delete medico failed:', err.message));
    await fetch(`${authBase}/admin/users/${userId}`, { method: 'DELETE', headers })
      .catch(err => console.error('[register-doctor] rollback delete user failed:', err.message));
    return res.status(500).json({ error: 'Errore di rete' });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 3 rimosso (categoria sulla prenotazione): nessun tipo di default alla registrazione
  // ───────────────────────────────────────────────────────────────────────────
  // ───────────────────────────────────────────────────────────────────────────
  // STEP 4: genera JWT approve token e salvalo su approve_tokens
  // ───────────────────────────────────────────────────────────────────────────
  const jti = crypto.randomUUID();
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + (7 * 24 * 60 * 60); // 7 giorni
  const expiresAtISO = new Date(expSec * 1000).toISOString();

  const jwtToken = signJwtHS256({ user_id: userId, jti, exp: expSec }, approveSecret);

  try {
    const insertTokenRes = await fetch(`${base}/approve_tokens`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jti, user_id: userId, expires_at: expiresAtISO })
    });
    if (!insertTokenRes.ok) {
      const errText = await insertTokenRes.text().catch(() => '');
      console.error('[register-doctor] insert approve_tokens failed:', insertTokenRes.status, errText);
      // Non rollback dell'utente: il medico esiste, può essere approvato manualmente da SQL
      // Però segnala l'errore.
      return res.status(500).json({ error: 'Account creato ma errore interno. Contatta il supporto.' });
    }
  } catch (e) {
    console.error('[register-doctor] insert approve_tokens exception:', e.message);
    return res.status(500).json({ error: 'Account creato ma errore interno. Contatta il supporto.' });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 5: invia email di notifica admin con link di approvazione
  // ───────────────────────────────────────────────────────────────────────────
  const approveLink = `https://delphi-med.com/api/approve-doctor?token=${encodeURIComponent(jwtToken)}`;
  const adminEmail = 'fb.castaldo@gmail.com';

  try {
    const resend = new Resend(resendApiKey);
    const { error: emailErr } = await resend.emails.send({
      from: 'noreply@delphi-med.com',
      to: [adminEmail],
      subject: 'Nuova registrazione medico — Delphi~Med',
      html: buildAdminRegistrationEmail({
        nome: esc(nome), cognome: esc(cognome), email: esc(email),
        ordineNumero: esc(ordineNumero), ordineProvincia: esc(ordineProvincia),
        telefono: esc(telefono), consensoCommerciale,
        approveLink
      })
    });
    if (emailErr) {
      console.error('[register-doctor] resend send error:', emailErr.message);
      // Non blocchiamo: l'admin può comunque trovare il token nei log o nel DB
    }
  } catch (e) {
    console.error('[register-doctor] resend exception:', e.message);
    // Idem: non blocchiamo
  }

  return res.status(200).json({ ok: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Template email admin (unica implementazione: il frontend non ne ha una copia)
// ─────────────────────────────────────────────────────────────────────────────
function buildAdminRegistrationEmail({ nome, cognome, email, ordineNumero, ordineProvincia, telefono, consensoCommerciale, approveLink }) {
  const rows =
    detailRow('Nome e cognome', `${nome} ${cognome}`) +
    detailRow('Email (verificata con codice)', email) +
    detailRow('Telefono', telefono) +
    detailRow('N&deg; iscrizione ordine', ordineNumero) +
    detailRow('Provincia ordine', ordineProvincia) +
    detailRow('Comunicazioni commerciali', consensoCommerciale ? 'consenso dato' : 'nessun consenso', { last: true });
  const body =
    emailTitle('Nuova richiesta di registrazione') +
    `<p style="font-size:15px;color:#333;margin:0 0 24px;">Un nuovo medico ha richiesto l&rsquo;accesso a Delphi~Med.</p>` +
    detailCard(rows) +
    ctaButton(approveLink, 'Approva medico') +
    `<p style="font-size:12px;color:#888;text-align:center;line-height:1.5;margin:0;">Link di approvazione valido per 7 giorni. Dopo l&rsquo;uso, il token verr&agrave; invalidato.</p>`;
  return emailShell(body);
}
