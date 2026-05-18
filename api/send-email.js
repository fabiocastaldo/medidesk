import { Resend } from 'resend';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'RESEND_API_KEY non configurata' });
  }

  const { to, subject, html: rawHtml, paziente_nome, medico_nome, medico_email, centro_nome, data, ora, tipo_visita, codice_cancellazione } = req.body || {};

  if (!to || typeof to !== 'string') {
    return res.status(400).json({ error: 'Campo to mancante o non valido' });
  }

  const resend = new Resend(apiKey);

  // Modalità generica: subject e html forniti direttamente
  if (subject && rawHtml) {
    try {
      const { error } = await resend.emails.send({ from: 'noreply@delphi-med.com', to: [to], subject, html: rawHtml });
      if (error) return res.status(500).json({ error: error.message });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    return res.status(200).json({ ok: true });
  }

  // Modalità template: email di conferma appuntamento
  let dataFmt = data || '';
  try {
    const d = new Date(data + 'T12:00:00');
    dataFmt = d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } catch (_) {}

  const html = buildHtml({
    paziente_nome:       esc(paziente_nome),
    medico_nome:         esc(medico_nome),
    centro_nome:         esc(centro_nome),
    dataFmt:             esc(dataFmt),
    ora:                 esc(ora),
    tipo_visita:         esc(tipo_visita) || '&mdash;',
    codice_cancellazione: esc(codice_cancellazione)
  });

  const emailPayload = {
    from:    'noreply@delphi-med.com',
    to:      [to],
    subject: `Conferma appuntamento con ${medico_nome || 'il medico'}`,
    html
  };
  if (medico_email) emailPayload.reply_to = medico_email;

  try {
    const { error } = await resend.emails.send(emailPayload);
    if (error) return res.status(500).json({ error: error.message });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  return res.status(200).json({ ok: true });
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
        Se non puoi venire, ti chiediamo gentilmente di cancellare il prima possibile: lo slot torner&agrave; subito disponibile per un altro paziente che ne ha bisogno. Hai tempo fino a 24 ore prima della visita.
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
