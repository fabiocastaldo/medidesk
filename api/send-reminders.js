export default async function handler(req, res) {
  // Auth: CRON_SECRET se configurato, altrimenti aperto (solo per test dev)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase env vars missing' });
  }

  const tomorrow = getTomorrowRome();
  const base    = `${supabaseUrl}/rest/v1`;
  const headers = {
    'apikey':        supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type':  'application/json'
  };

  // 1. Appuntamenti di domani da ricordare
  let appointments;
  try {
    const r = await fetch(
      `${base}/appuntamenti?data=eq.${tomorrow}&cancelled=eq.false&reminder_sent=eq.false&email_paziente=not.is.null`,
      { headers }
    );
    if (!r.ok) throw new Error(`Supabase query failed: ${r.status}`);
    const all = await r.json();
    appointments = all.filter(a => a.email_paziente && a.email_paziente.trim() !== '');
  } catch (e) {
    console.error('[send-reminders] query appuntamenti:', e.message);
    return res.status(500).json({ error: e.message });
  }

  if (!appointments.length) {
    return res.status(200).json({ processed: 0, sent: 0, errors: 0, date: tomorrow });
  }

  // 2. Fetch centri e medici in batch (evita N+1)
  const centroIds = [...new Set(appointments.map(a => a.centro_id).filter(Boolean))];
  const medicoIds = [...new Set(appointments.map(a => a.medico_id).filter(Boolean))];

  const centriMap = {};
  if (centroIds.length) {
    try {
      const r = await fetch(
        `${base}/centri?id=in.(${centroIds.join(',')})&select=id,nome,via,citta,provincia,cap`,
        { headers }
      );
      const rows = await r.json();
      rows.forEach(c => { centriMap[c.id] = c; });
    } catch (e) { console.error('[send-reminders] query centri:', e.message); }
  }

  const mediciMap = {};
  if (medicoIds.length) {
    try {
      const r = await fetch(
        `${base}/medici?id=in.(${medicoIds.join(',')})&select=id,titolo,nome,cognome`,
        { headers }
      );
      const rows = await r.json();
      rows.forEach(m => { mediciMap[m.id] = m; });
    } catch (e) { console.error('[send-reminders] query medici:', e.message); }
  }

  // 3. Invia reminder per ogni appuntamento
  let sent = 0, errors = 0;

  for (const appt of appointments) {
    const centro = centriMap[appt.centro_id] || {};
    const medico = mediciMap[appt.medico_id] || {};

    const medicoNome    = [medico.titolo, medico.nome, medico.cognome].filter(Boolean).join(' ') || 'il medico';
    const pazienteNome  = [appt.nome_paziente, appt.cognome_paziente].filter(Boolean).join(' ');
    const dataFmt       = formatDateIt(appt.data);
    const centroIndirizzo = buildAddress(centro);

    const subject = `Promemoria visita di domani — ${medicoNome}`;
    const html    = buildReminderHtml({ pazienteNome, medicoNome, dataFmt, ora: appt.ora, tipoVisita: appt.tipo_visita, centroNome: centro.nome, centroIndirizzo });

    try {
      const emailRes = await fetch('https://delphi-med.com/api/send-email', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ to: appt.email_paziente, subject, html })
      });
      if (!emailRes.ok) {
        const errBody = await emailRes.text().catch(() => '');
        throw new Error(`send-email ${emailRes.status}: ${errBody}`);
      }
      // Marca come inviato solo se l'email è andata a buon fine
      await fetch(`${base}/appuntamenti?id=eq.${appt.id}`, {
        method:  'PATCH',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body:    JSON.stringify({ reminder_sent: true })
      });
      sent++;
    } catch (e) {
      console.error(`[send-reminders] appt ${appt.id}:`, e.message);
      errors++;
      // NON aggiorna reminder_sent: verrà ritentato alla prossima esecuzione
    }
  }

  return res.status(200).json({ processed: appointments.length, sent, errors, date: tomorrow });
}

// Calcola "domani" nel fuso Europe/Rome (robusto al cambio ora legale/solare)
function getTomorrowRome() {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(tomorrow);
}

function formatDateIt(dateStr) {
  try {
    return new Date(dateStr + 'T12:00:00')
      .toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } catch (_) { return dateStr; }
}

function buildAddress(centro) {
  return [
    centro.via,
    [centro.cap, centro.citta].filter(Boolean).join(' '),
    centro.provincia
  ].filter(Boolean).join(', ');
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildReminderHtml({ pazienteNome, medicoNome, dataFmt, ora, tipoVisita, centroNome, centroIndirizzo }) {
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f4f4;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f4;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:560px;">
  <tr>
    <td style="background:#0D9488;padding:32px 40px;text-align:center;">
      <p style="margin:0;font-size:30px;color:#ffffff;">&#128336;</p>
      <p style="margin:8px 0 0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.3px;">Promemoria visita</p>
      <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px;">Delphi~Med</p>
    </td>
  </tr>
  <tr>
    <td style="padding:36px 40px;">
      <p style="font-size:16px;color:#1a1a1a;margin:0 0 12px;">Gentile <strong>${esc(pazienteNome)}</strong>,</p>
      <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 28px;">
        ti ricordiamo che hai una visita prenotata <strong>domani</strong>.
      </p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdfb;border:1px solid #ccece9;border-radius:8px;margin-bottom:28px;">
        <tr><td style="padding:20px 24px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:8px 0;border-bottom:1px solid #d9f0ee;">
              <span style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">&#128100;&nbsp; Medico</span><br>
              <strong style="color:#111;font-size:14px;">${esc(medicoNome)}</strong>
            </td></tr>
            <tr><td style="padding:8px 0;border-bottom:1px solid #d9f0ee;">
              <span style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">&#128197;&nbsp; Data</span><br>
              <strong style="color:#111;font-size:14px;">${esc(dataFmt)}</strong>
            </td></tr>
            <tr><td style="padding:8px 0;border-bottom:1px solid #d9f0ee;">
              <span style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">&#128336;&nbsp; Ora</span><br>
              <strong style="color:#111;font-size:14px;">${esc(ora || '—')}</strong>
            </td></tr>
            ${tipoVisita ? `<tr><td style="padding:8px 0;border-bottom:1px solid #d9f0ee;">
              <span style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">&#129658;&nbsp; Tipo visita</span><br>
              <strong style="color:#111;font-size:14px;">${esc(tipoVisita)}</strong>
            </td></tr>` : ''}
            <tr><td style="padding:8px 0;${tipoVisita ? '' : 'border-bottom:none'}">
              <span style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">&#127973;&nbsp; Centro</span><br>
              <strong style="color:#111;font-size:14px;">${esc(centroNome || '—')}</strong>
              ${centroIndirizzo ? `<br><span style="color:#555;font-size:13px;">${esc(centroIndirizzo)}</span>` : ''}
            </td></tr>
          </table>
        </td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border-left:3px solid #f59e0b;border-radius:0 6px 6px 0;margin-bottom:28px;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0 0 6px;font-size:13px;color:#555;font-weight:700;">&#128203; Cosa portare alla visita</p>
          <p style="margin:0;font-size:13px;color:#555;line-height:1.6;">
            Documentazione sanitaria (referti, esami precedenti, cartelle cliniche), tessera sanitaria, eventuali farmaci che assumi regolarmente, documento di identità e ogni altro documento rilevante per la visita.
          </p>
        </td></tr>
      </table>
      <p style="font-size:13px;color:#888;margin:0;">Per cancellare o modificare l&rsquo;appuntamento usa il codice di cancellazione ricevuto al momento della prenotazione.</p>
    </td>
  </tr>
  <tr>
    <td style="background:#f8f8f8;border-top:1px solid #eeeeee;padding:18px 40px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#bbb;">Email automatica inviata da Delphi~Med &middot; Non rispondere a questo indirizzo</p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
