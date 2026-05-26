import crypto from 'crypto';
import { Resend } from 'resend';

// ─────────────────────────────────────────────────────────────────────────────
// Rate limit in-memory: 5 registrazioni/ora per IP (anti-spam abuse)
// ─────────────────────────────────────────────────────────────────────────────
const regRateMap = new Map();
const REG_RATE_LIMIT = 5;
const REG_RATE_WINDOW_MS = 60 * 60 * 1000;

function checkRegRateLimit(ip) {
  const now = Date.now();
  const entry = regRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    regRateMap.set(ip, { count: 1, resetAt: now + REG_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= REG_RATE_LIMIT) return false;
  entry.count++;
  return true;
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
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const approveSecret = process.env.APPROVE_TOKEN_SECRET;
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!supabaseUrl || !serviceKey || !approveSecret || !resendApiKey) {
    console.error('[register-doctor] env vars mancanti');
    return res.status(500).json({ error: 'Configurazione server incompleta' });
  }

  // Rate limit per IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             req.socket?.remoteAddress || 'unknown';
  if (!checkRegRateLimit(ip)) {
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

  const base = `${supabaseUrl}/rest/v1`;
  const authBase = `${supabaseUrl}/auth/v1`;
  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 1: crea utente in Supabase Auth (email_confirm: true salta verifica)
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
  // STEP 3: INSERT default tipi_visita (best-effort, non blocca su errore)
  // ───────────────────────────────────────────────────────────────────────────
  if (medicoId) {
    try {
      await fetch(`${base}/tipi_visita`, {
        method: 'POST',
        headers,
        body: JSON.stringify([
          { medico_id: medicoId, nome: 'Prima visita', is_default: true },
          { medico_id: medicoId, nome: 'Controllo', is_default: true }
        ])
      });
    } catch (e) {
      console.warn('[register-doctor] insert tipi_visita failed (non bloccante):', e.message);
    }
  }

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
// Template email admin (identico a buildAdminRegistrationEmail del frontend)
// ─────────────────────────────────────────────────────────────────────────────
function buildAdminRegistrationEmail({ nome, cognome, email, ordineNumero, ordineProvincia, approveLink }) {
  return `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0f4f4;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f4;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:560px;">
<tr><td style="background:#0D9488;padding:32px 40px;text-align:center;">
  <p style="margin:0;font-size:28px;color:#fff;">&#128711;</p>
  <p style="margin:8px 0 0;color:#fff;font-size:20px;font-weight:700;">Nuova richiesta di registrazione</p>
  <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px;">Delphi~Med &mdash; Pannello di approvazione</p>
</td></tr>
<tr><td style="padding:32px 40px;">
  <p style="font-size:15px;color:#333;margin:0 0 24px;">Un nuovo medico ha richiesto l&rsquo;accesso a Delphi~Med.</p>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdfb;border:1px solid #ccece9;border-radius:8px;margin-bottom:28px;">
  <tr><td style="padding:20px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:8px 0;border-bottom:1px solid #d9f0ee;">
        <span style="color:#666;font-size:11px;text-transform:uppercase;letter-spacing:.5px;">Nome e Cognome</span><br>
        <strong style="color:#111;font-size:14px;">${nome} ${cognome}</strong>
      </td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #d9f0ee;">
        <span style="color:#666;font-size:11px;text-transform:uppercase;letter-spacing:.5px;">Email</span><br>
        <strong style="color:#111;font-size:14px;">${email}</strong>
      </td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #d9f0ee;">
        <span style="color:#666;font-size:11px;text-transform:uppercase;letter-spacing:.5px;">N&deg; Iscrizione Ordine</span><br>
        <strong style="color:#111;font-size:14px;">${ordineNumero}</strong>
      </td></tr>
      <tr><td style="padding:8px 0;">
        <span style="color:#666;font-size:11px;text-transform:uppercase;letter-spacing:.5px;">Provincia Ordine</span><br>
        <strong style="color:#111;font-size:14px;">${ordineProvincia}</strong>
      </td></tr>
    </table>
  </td></tr>
  </table>
  <div style="text-align:center;margin:0 0 24px;">
    <a href="${approveLink}" style="display:inline-block;padding:14px 32px;background:#0D9488;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;">Approva medico</a>
  </div>
  <p style="font-size:12px;color:#888;text-align:center;line-height:1.5;margin:0;">
    Link di approvazione valido per 7 giorni. Dopo l&rsquo;uso, il token verr&agrave; invalidato.
  </p>
</td></tr>
<tr><td style="background:#f8f8f8;border-top:1px solid #eee;padding:18px 40px;text-align:center;">
  <p style="margin:0;font-size:11px;color:#bbb;">Messaggio inviato automaticamente da Delphi~Med</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
