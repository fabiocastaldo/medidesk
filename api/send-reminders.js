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

  let sent = 0, errors = 0;

  if (appointments.length) {
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
        const emailRes = await fetch('https://www.delphi-med.com/api/send-email', {
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
  }

  // 4. Notifiche turni in scadenza (60gg e 30gg)
  await checkTurniScadenza(base, headers);

  return res.status(200).json({ processed: appointments.length, sent, errors, date: tomorrow });
}

// ── NOTIFICHE TURNI IN SCADENZA ──────────────────────────────────────────────

async function checkTurniScadenza(base, headers) {
  const todayUTC = getTodayUTC();
  const soglie = [
    { giorni: 60, data: addDaysToDateStr(todayUTC, 60), campo: 'notified_60d_at' },
    { giorni: 30, data: addDaysToDateStr(todayUTC, 30), campo: 'notified_30d_at' },
  ];
  for (const soglia of soglie) {
    await processScadenzaSoglia(base, headers, soglia);
  }
}

async function processScadenzaSoglia(base, headers, { giorni, data, campo }) {
  // a) Query turni per la data-soglia non ancora notificati
  let turni;
  try {
    const r = await fetch(
      `${base}/turni?data_fine_validita=eq.${data}&${campo}=is.null&select=*`,
      { headers }
    );
    if (!r.ok) throw new Error(`query turni ${r.status}`);
    turni = await r.json();
  } catch (e) {
    console.error(`[turni-scadenza] soglia ${giorni}d query turni:`, e.message);
    return;
  }

  if (!turni.length) {
    console.log(`[turni-scadenza] soglia ${giorni}d: nessun turno da notificare`);
    return;
  }

  // Fetch centri
  const centroIds = [...new Set(turni.map(t => t.centro_id).filter(Boolean))];
  const centriMap = {};
  try {
    const r = await fetch(
      `${base}/centri?id=in.(${centroIds.join(',')})&select=id,nome,medico_id`,
      { headers }
    );
    const rows = await r.json();
    rows.forEach(c => { centriMap[c.id] = c; });
  } catch (e) {
    console.error(`[turni-scadenza] soglia ${giorni}d query centri:`, e.message);
    return;
  }

  // Fetch medici (solo non eliminati)
  const medicoIds = [...new Set(Object.values(centriMap).map(c => c.medico_id).filter(Boolean))];
  if (!medicoIds.length) return;
  const mediciMap = {};
  try {
    const r = await fetch(
      `${base}/medici?id=in.(${medicoIds.join(',')})&deleted_at=is.null&select=id,email,nome,cognome`,
      { headers }
    );
    const rows = await r.json();
    rows.forEach(m => { mediciMap[m.id] = m; });
  } catch (e) {
    console.error(`[turni-scadenza] soglia ${giorni}d query medici:`, e.message);
    return;
  }

  // b) Raggruppa per medico
  const byMedico = {};
  for (const t of turni) {
    const centro = centriMap[t.centro_id];
    if (!centro) continue;
    const medico = mediciMap[centro.medico_id];
    if (!medico) continue; // medico eliminato, skip
    if (!medico.email) continue;

    if (!byMedico[medico.id]) {
      byMedico[medico.id] = { medico, turni: [] };
    }
    byMedico[medico.id].turni.push({ ...t, centro_nome: centro.nome });
  }

  // c) Invia email aggregata per medico
  let emailInviate = 0, turniNotificati = 0;

  for (const { medico, turni: medicoTurni } of Object.values(byMedico)) {
    const count = medicoTurni.length;
    const subject = count === 1
      ? `Promemoria: il tuo turno scadrà tra ${giorni} giorni`
      : `Promemoria: hai ${count} turni in scadenza tra ${giorni} giorni`;
    const html = buildScadenzaHtml({ medico, turni: medicoTurni, giorni });

    try {
      const emailRes = await fetch('https://www.delphi-med.com/api/send-email', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ to: medico.email, subject, html })
      });
      if (!emailRes.ok) {
        const errBody = await emailRes.text().catch(() => '');
        throw new Error(`send-email ${emailRes.status}: ${errBody}`);
      }

      // Aggiorna notified_Xd_at solo se email OK
      const ids = medicoTurni.map(t => t.id);
      await fetch(`${base}/turni?id=in.(${ids.join(',')})`, {
        method:  'PATCH',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body:    JSON.stringify({ [campo]: new Date().toISOString() })
      });

      // Audit log per ogni turno del batch
      const sentAt = new Date().toISOString();
      for (const t of medicoTurni) {
        await auditLogCron(base, headers, medico.id, 'notifica_scadenza_turno_inviata', 'turno', t.id, {
          soglia: giorni,
          sent_at: sentAt,
          count_turni_batch: count
        });
      }

      emailInviate++;
      turniNotificati += count;
    } catch (e) {
      console.error(`[turni-scadenza] soglia ${giorni}d medico ${medico.id}:`, e.message);
      // NON aggiorna notified_Xd_at: verrà ritentato domani
    }
  }

  // d) Log finale
  console.log(`[turni-scadenza] soglia ${giorni}d: ${emailInviate} email inviate, ${turniNotificati} turni notificati`);
}

async function auditLogCron(base, headers, medicoId, action, targetType, targetId, details) {
  try {
    await fetch(`${base}/audit_log`, {
      method:  'POST',
      headers: { ...headers, 'Prefer': 'return=minimal' },
      body:    JSON.stringify({
        medico_id:   medicoId,
        action,
        target_type: targetType,
        target_id:   targetId ? String(targetId) : null,
        details:     details || {}
      })
    });
  } catch (e) {
    console.error('[turni-scadenza] auditLog failed:', e.message);
  }
}

// ── HELPERS ──────────────────────────────────────────────────────────────────

// Calcola "domani" nel fuso Europe/Rome (robusto al cambio ora legale/solare)
function getTomorrowRome() {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(tomorrow);
}

// Oggi in UTC (accettabile per soglie 60/30gg — piccolo drift su CEST non critico)
function getTodayUTC() {
  return new Date().toISOString().substring(0, 10);
}

function addDaysToDateStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().substring(0, 10);
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

// ── EMAIL TEMPLATES ──────────────────────────────────────────────────────────

const GIORNI_IT = ['Domenica','Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato'];

function buildScadenzaHtml({ medico, turni, giorni }) {
  const nomeCompleto = [medico.nome, medico.cognome].filter(Boolean).join(' ');
  const n = turni.length;
  const turniRows = turni.map(t => {
    const giorno    = GIORNI_IT[t.giorno] || '';
    const inizio    = (t.inizio || '').substring(0, 5);
    const fine      = (t.fine   || '').substring(0, 5);
    const scadenza  = formatDateIt(t.data_fine_validita);
    const centroNome = esc(t.centro_nome || '—');
    return `<tr><td style="padding:8px 0;border-bottom:1px solid #d9f0ee;font-size:14px;color:#111;">
      &#8226; Centro <strong>${centroNome}</strong>: ${esc(giorno)} ${esc(inizio)}–${esc(fine)}, scadenza <strong>${esc(scadenza)}</strong>
    </td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f4f4;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f4;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:560px;">
  <tr>
    <td style="background:#0D9488;padding:32px 40px;text-align:center;">
      <p style="margin:0;font-size:30px;color:#ffffff;">&#128197;</p>
      <p style="margin:8px 0 0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.3px;">Promemoria scadenza turno</p>
      <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px;">Delphi~Med</p>
    </td>
  </tr>
  <tr>
    <td style="padding:36px 40px;">
      <p style="font-size:16px;color:#1a1a1a;margin:0 0 12px;">Ciao <strong>${esc(nomeCompleto)}</strong>,</p>
      <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 24px;">
        questo è un promemoria automatico: hai <strong>${n} turno${n !== 1 ? '/i' : ''} ricorrente${n !== 1 ? '/i' : ''}</strong> in scadenza tra <strong>${giorni} giorni</strong>.
      </p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdfb;border:1px solid #ccece9;border-radius:8px;margin-bottom:24px;">
        <tr><td style="padding:20px 24px;">
          <p style="margin:0 0 12px;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#666;font-weight:600;">Turni in scadenza</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            ${turniRows}
          </table>
        </td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border-left:3px solid #f59e0b;border-radius:0 6px 6px 0;margin-bottom:24px;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0 0 6px;font-size:13px;color:#555;font-weight:700;">Cosa succede a scadenza</p>
          <ul style="margin:0;padding-left:18px;font-size:13px;color:#555;line-height:1.7;">
            <li>Il turno non genererà più nuovi slot prenotabili</li>
            <li>Gli appuntamenti già prenotati restano in agenda</li>
          </ul>
        </td></tr>
      </table>
      <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 8px;">
        Se vuoi prorogare o modificare la scadenza, accedi a <strong>Delphi~Med → Centri</strong> e clicca il bottone calendario sul turno interessato.
      </p>
      <p style="font-size:14px;color:#555;margin:0 0 28px;">Buon lavoro,<br><strong>Delphi~Med</strong></p>
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
