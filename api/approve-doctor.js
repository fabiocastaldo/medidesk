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

  const endpoint = `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(token)}`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'PATCH',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ stato: 'approvato' })
    });
  } catch (e) {
    return res.status(500).send(htmlPage('Errore di rete', `&#10060; Impossibile contattare il database: ${esc(e.message)}`));
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    return res.status(500).send(htmlPage('Errore del database', `&#10060; Aggiornamento fallito (HTTP ${response.status}): ${esc(errText)}`));
  }

  return res.status(200).send(htmlPage(
    'Medico approvato',
    '&#9989; Medico approvato con successo! L&rsquo;utente pu&ograve; ora accedere a Delphi Med.'
  ));
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
