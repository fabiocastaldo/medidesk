import crypto from 'crypto';
import { Resend } from 'resend';

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
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f4f4;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f4;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:560px;">
  <tr>
    <td style="background:#0D9488;padding:32px 40px;text-align:center;">
      <p style="margin:0;font-size:30px;color:#fff;">&#9989;</p>
      <p style="margin:8px 0 0;color:#fff;font-size:20px;font-weight:700;letter-spacing:.3px;">Account approvato</p>
      <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px;">Delphi~Med</p>
    </td>
  </tr>
  <tr>
    <td style="padding:36px 40px;">
      <p style="font-size:16px;color:#1a1a1a;margin:0 0 16px;">Gentile <strong>${nomeCompleto}</strong>,</p>
      <p style="font-size:15px;color:#444;line-height:1.7;margin:0 0 28px;">
        Il tuo account Delphi~Med &egrave; stato approvato.<br>
        Puoi ora accedere alla piattaforma e iniziare a gestire il tuo studio.
      </p>
      <div style="text-align:center;margin-bottom:28px;">
        <a href="https://delphi-med.com" style="display:inline-block;background:#0D9488;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">Accedi a Delphi~Med</a>
      </div>
      <p style="font-size:13px;color:#888;text-align:center;margin:0;">
        Oppure copia il link: <a href="https://delphi-med.com" style="color:#0D9488;">https://delphi-med.com</a>
      </p>
    </td>
  </tr>
  <tr>
    <td style="background:#f8f8f8;border-top:1px solid #eee;padding:18px 40px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#bbb;">Messaggio inviato automaticamente da Delphi~Med</p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler principale
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const token = req.query?.token;
  if (!token || typeof token !== 'string' || token.trim() === '') {
    return res.status(400).send(htmlPage('Errore', 'Parametro token mancante o non valido.', false));
  }

  // Env vars
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const approveSecret = process.env.APPROVE_TOKEN_SECRET;
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!supabaseUrl || !serviceKey || !approveSecret) {
    console.error('[approve-doctor] env vars mancanti');
    return res.status(500).send(htmlPage('Errore di configurazione', 'Configurazione server incompleta.', false));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 1: verifica firma JWT
  // ───────────────────────────────────────────────────────────────────────────
  const payload = verifyJwtHS256(token, approveSecret);
  if (!payload) {
    console.warn('[approve-doctor] JWT con firma invalida o malformato');
    return res.status(401).send(htmlPage('Token non valido', 'Il link di approvazione non è valido. Potrebbe essere stato manomesso.', false));
  }

  const { user_id: userId, jti, exp } = payload;
  if (!userId || !jti || !exp) {
    console.warn('[approve-doctor] JWT con payload incompleto');
    return res.status(401).send(htmlPage('Token non valido', 'Il link di approvazione non contiene tutti i dati richiesti.', false));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 2: verifica expiry
  // ───────────────────────────────────────────────────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000);
  if (exp < nowSec) {
    return res.status(401).send(htmlPage('Link scaduto', 'Questo link di approvazione è scaduto. Richiedi al medico di registrarsi nuovamente.', false));
  }

  const base = `${supabaseUrl}/rest/v1`;
  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 3: marca il token come usato (atomico). Se used_at era già valorizzato,
  // l'UPDATE non tocca nessuna riga e capiamo che il token era già consumato.
  // ───────────────────────────────────────────────────────────────────────────
  let markedRows;
  try {
    const markRes = await fetch(
      `${base}/approve_tokens?jti=eq.${encodeURIComponent(jti)}&used_at=is.null&select=jti`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify({ used_at: new Date().toISOString() })
      }
    );
    if (!markRes.ok) {
      const errText = await markRes.text().catch(() => '');
      console.error('[approve-doctor] mark token failed:', markRes.status, errText);
      return res.status(500).send(htmlPage('Errore database', 'Impossibile validare il token. Riprova più tardi.', false));
    }
    markedRows = await markRes.json().catch(() => []);
  } catch (e) {
    console.error('[approve-doctor] mark token exception:', e.message);
    return res.status(500).send(htmlPage('Errore di rete', 'Impossibile contattare il database.', false));
  }

  if (!Array.isArray(markedRows) || markedRows.length === 0) {
    // Nessuna riga aggiornata → o jti non esiste (token forgiato con firma valida
    // ma jti inventato — impossibile senza secret, ma per completezza), oppure
    // token già usato.
    return res.status(409).send(htmlPage('Token già usato', 'Questo link di approvazione è già stato utilizzato in precedenza.', false));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 4: PATCH stato medico = 'approvato' + recupera dati per email
  // ───────────────────────────────────────────────────────────────────────────
  let medico = null;
  try {
    const patchRes = await fetch(
      `${base}/medici?user_id=eq.${encodeURIComponent(userId)}&select=email,nome,cognome`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify({ stato: 'approvato' })
      }
    );
    if (!patchRes.ok) {
      const errText = await patchRes.text().catch(() => '');
      console.error('[approve-doctor] patch medici failed:', patchRes.status, errText);
      return res.status(500).send(htmlPage('Errore database', 'Impossibile approvare il medico.', false));
    }
    const rows = await patchRes.json().catch(() => []);
    medico = Array.isArray(rows) ? rows[0] : null;

    if (!medico) {
      // Edge case: token valido, marcato usato, ma medico non trovato (cancellato?).
      console.warn('[approve-doctor] medico non trovato per user_id:', userId);
      return res.status(404).send(htmlPage('Medico non trovato', 'Il medico associato a questo token non esiste più nel sistema.', false));
    }
  } catch (e) {
    console.error('[approve-doctor] patch medici exception:', e.message);
    return res.status(500).send(htmlPage('Errore di rete', 'Impossibile contattare il database.', false));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 5: invia email di approvazione al medico (best-effort, non blocca)
  // L'email parte direttamente via Resend, senza passare da /api/send-email.
  // ───────────────────────────────────────────────────────────────────────────
  if (medico.email && resendApiKey) {
    try {
      const resend = new Resend(resendApiKey);
      const { error: emailErr } = await resend.emails.send({
        from: 'noreply@delphi-med.com',
        to: [medico.email],
        subject: 'Account approvato — Delphi~Med',
        html: buildApprovalEmail({ nome: medico.nome, cognome: medico.cognome })
      });
      if (emailErr) {
        console.error('[approve-doctor] resend send error:', emailErr.message);
      } else {
        console.log('[approve-doctor] email di approvazione inviata');
      }
    } catch (e) {
      console.error('[approve-doctor] resend exception:', e.message);
    }
  } else if (!medico.email) {
    console.warn('[approve-doctor] email medico mancante, invio saltato');
  } else if (!resendApiKey) {
    console.warn('[approve-doctor] RESEND_API_KEY mancante, invio saltato');
  }

  return res.status(200).send(htmlPage(
    'Medico approvato',
    'Medico approvato con successo. L\'utente può ora accedere a Delphi~Med.',
    true
  ));
}
