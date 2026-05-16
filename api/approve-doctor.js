export default async function handler(req, res) {
  const token = req.query?.token;

  if (!token || typeof token !== 'string' || token.trim() === '') {
    return res.status(400).send(htmlPage('Errore', '&#10060; Parametro token mancante o non valido.'));
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).send(htmlPage('Errore di configurazione', '&#10060; Variabili d&rsquo;ambiente Supabase non configurate.'));
  }

  const base    = `${supabaseUrl}/rest/v1`;
  const headers = {
    'apikey':        supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type':  'application/json'
  };

  // Aggiorna stato e recupera dati medico in un'unica chiamata
  let patchResponse;
  try {
    patchResponse = await fetch(
      `${base}/medici?user_id=eq.${encodeURIComponent(token)}&select=email,nome,cognome`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify({ stato: 'approvato' })
      }
    );
  } catch (e) {
    return res.status(500).send(htmlPage('Errore di rete', `&#10060; Impossibile contattare il database: ${esc(e.message)}`));
  }

  if (!patchResponse.ok) {
    const errText = await patchResponse.text().catch(() => '');
    return res.status(500).send(htmlPage('Errore del database', `&#10060; Aggiornamento fallito (HTTP ${patchResponse.status}): ${esc(errText)}`));
  }

  // Recupera dati medico dalla risposta del PATCH
  let medico = null;
  try {
    const rows = await patchResponse.json();
    medico = Array.isArray(rows) ? rows[0] : rows;
    console.log('[approve-doctor] dati medico recuperati:', JSON.stringify(medico));
  } catch (e) {
    console.error('[approve-doctor] errore parsing risposta PATCH:', e.message);
  }

  // Invia email di approvazione al medico
  if (medico?.email) {
    try {
      const emailRes = await fetch('https://delphi-med.com/api/send-email', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to:      medico.email,
          subject: 'Account approvato — Delphi Med',
          html:    buildApprovalEmail({ nome: medico.nome, cognome: medico.cognome })
        })
      });
      if (emailRes.ok) {
        console.log('[approve-doctor] email di approvazione inviata a:', medico.email);
      } else {
        const errBody = await emailRes.text().catch(() => '');
        console.error('[approve-doctor] send-email ha risposto con errore HTTP', emailRes.status, errBody);
      }
    } catch (e) {
      console.error('[approve-doctor] errore chiamata send-email:', e.message);
    }
  } else {
    console.warn('[approve-doctor] email medico non trovata — invio email saltato. Dati:', JSON.stringify(medico));
  }

  return res.status(200).send(htmlPage(
    'Medico approvato',
    '&#9989; Medico approvato con successo! L&rsquo;utente pu&ograve; ora accedere a Delphi Med.'
  ));
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
      <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px;">Delphi Med</p>
    </td>
  </tr>
  <tr>
    <td style="padding:36px 40px;">
      <p style="font-size:16px;color:#1a1a1a;margin:0 0 16px;">Gentile <strong>${nomeCompleto}</strong>,</p>
      <p style="font-size:15px;color:#444;line-height:1.7;margin:0 0 28px;">
        Il tuo account Delphi Med &egrave; stato approvato.<br>
        Puoi ora accedere alla piattaforma e iniziare a gestire il tuo studio.
      </p>
      <div style="text-align:center;margin-bottom:28px;">
        <a href="https://delphi-med.com" style="display:inline-block;background:#0D9488;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">Accedi a Delphi Med</a>
      </div>
      <p style="font-size:13px;color:#888;text-align:center;margin:0;">
        Oppure copia il link: <a href="https://delphi-med.com" style="color:#0D9488;">https://delphi-med.com</a>
      </p>
    </td>
  </tr>
  <tr>
    <td style="background:#f8f8f8;border-top:1px solid #eee;padding:18px 40px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#bbb;">Messaggio inviato automaticamente da Delphi Med</p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function htmlPage(title, message) {
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} — Delphi Med</title>
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
    <div class="logo">Delphi Med</div>
    <div class="icon">${message.startsWith('&#9989;') ? '&#9989;' : '&#10060;'}</div>
    <h1>${esc(title)}</h1>
    <p>${message.replace(/^&#9989; |^&#10060; /, '')}</p>
  </div>
</body>
</html>`;
}
