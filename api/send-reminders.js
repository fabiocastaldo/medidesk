import { Resend } from 'resend';
import { emailShell, emailTitle, detailCard, detailRow, noteBox, ctaButton } from '../lib/email-shell.js';
import { smsEnabled, sendSms } from '../lib/sms.js';

// Helper a livello di modulo: un canale è utilizzabile solo se il relativo
// contatto è presente e non vuoto.
const hasEmail = a => !!(a.email_paziente && a.email_paziente.trim());
const hasTel   = a => !!(a.telefono_paziente && a.telefono_paziente.trim());

// Retry in-run: UN solo ritentativo dopo un breve delay, poi l'errore residuo
// si registra e finisce nell'alert admin. Budget maxDuration alzato a 60s in
// vercel.json: il delay scatta solo sui fallimenti.
const RETRY_DELAY_MS = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Invio email con 1 ritentativo. Ritorna sempre un oggetto, non lancia mai.
async function sendEmailWithRetry(resend, payload) {
  for (let attempt = 1; ; attempt++) {
    try {
      const { error } = await resend.emails.send(payload);
      if (error) throw new Error(error.message);
      return { ok: true };
    } catch (e) {
      if (attempt >= 2) return { ok: false, error: e.message };
      await sleep(RETRY_DELAY_MS);
    }
  }
}

// Invio SMS con 1 ritentativo. sendSms non lancia mai; skipped non si ritenta.
async function sendSmsWithRetry(args) {
  let r = await sendSms(args);
  if (!r.ok && !r.skipped) {
    await sleep(RETRY_DELAY_MS);
    r = await sendSms(args);
  }
  return r;
}

export default async function handler(req, res) {
  // Auth: CRON_SECRET obbligatorio. Vercel Cron lo inietta automaticamente
  // come header Authorization: Bearer <CRON_SECRET> nelle chiamate scheduled.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[send-reminders] CRON_SECRET non configurato');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }
  if (req.headers['authorization'] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase env vars missing' });
  }
  if (!resendApiKey) {
    console.error('[send-reminders] RESEND_API_KEY non configurato');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }
  const resend = new Resend(resendApiKey);

  // Errori residui DOPO il retry, per l'alert admin di fine run.
  // Nessun dato personale: solo id di riga (etichettati) ed error message.
  const runErrors = [];

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
      `${base}/appuntamenti?data=eq.${tomorrow}&cancelled=eq.false&or=(and(email_paziente.not.is.null,reminder_sent.eq.false),and(telefono_paziente.not.is.null,sms_sent_at.is.null))`,
      { headers }
    );
    if (!r.ok) throw new Error(`Supabase query failed: ${r.status}`);
    const all = await r.json();
    appointments = all.filter(a => hasEmail(a) || hasTel(a));
  } catch (e) {
    console.error('[send-reminders] query appuntamenti:', e.message);
    return res.status(500).json({ error: 'Internal error' });
  }

  let sent = 0, errors = 0;
  let smsSent = 0, smsErrors = 0;

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
          `${base}/medici?id=in.(${medicoIds.join(',')})&select=id,titolo,nome,cognome,email`,
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

      // Un solo PATCH per riga, a contenuto variabile: ogni canale scrive il
      // proprio flag di dedup solo su invio riuscito. I due rami sono
      // indipendenti — il fallimento di uno non salta l'altro.
      const patch = {};

      // RAMO EMAIL — invariato rispetto a prima (stesso subject/html/reply_to).
      if (hasEmail(appt) && !appt.reminder_sent) {
        const subject = `Promemoria visita di domani — ${medicoNome}`;
        const html    = buildReminderHtml({ pazienteNome, medicoNome, dataFmt, ora: appt.ora, tipoVisita: appt.tipo_visita, centroNome: centro.nome, centroIndirizzo });
        const er = await sendEmailWithRetry(resend, {
          from:     'noreply@delphi-med.com',
          to:       [appt.email_paziente],
          subject,
          html,
          ...(medico.email ? { reply_to: medico.email } : {})
        });
        if (er.ok) {
          patch.reminder_sent = true;
          sent++;
        } else {
          console.error(`[send-reminders] appt ${appt.id} email:`, er.error);
          errors++;
          // La query filtra sulla data di DOMANI: questa riga non sarà mai
          // rivista da una run successiva. Il rimedio è l'alert admin.
          runErrors.push({ ramo: 'promemoria-email', ref: `appuntamenti.id ${appt.id}`, msg: er.error });
        }
      }

      // RAMO SMS — inerte senza env Skebby (smsEnabled() false).
      if (smsEnabled() && hasTel(appt) && !appt.sms_sent_at) {
        const r = await sendSmsWithRetry({
          to:   appt.telefono_paziente,
          text: buildReminderSms({ medicoNome, dataShort: formatDateShort(appt.data), ora: String(appt.ora || '').substring(0, 5), centroNome: centro.nome })
        });
        if (r.ok) {
          patch.sms_sent_at = new Date().toISOString();
          smsSent++;
        } else if (r.skipped) {
          // Numero non valido/assente o provider off: niente patch. Domani la
          // visita è passata, quindi nessun retry infinito.
          console.log(`[send-reminders] appt ${appt.id} sms skipped: ${r.skipped}`);
        } else {
          console.error(`[send-reminders] appt ${appt.id} sms:`, r.error);
          smsErrors++;
          // La query filtra sulla data di DOMANI: nessuna run successiva
          // rivedrà questa riga. Il rimedio è l'alert admin.
          runErrors.push({ ramo: 'promemoria-sms', ref: `appuntamenti.id ${appt.id}`, msg: r.error });
        }
      }

      // Un solo PATCH con quanto effettivamente riuscito.
      if (Object.keys(patch).length) {
        await fetch(`${base}/appuntamenti?id=eq.${appt.id}`, {
          method:  'PATCH',
          headers: { ...headers, 'Prefer': 'return=minimal' },
          body:    JSON.stringify(patch)
        });
      }
    }
  }

  // 4. Notifiche turni in scadenza (60gg e 30gg)
  await checkTurniScadenza(base, headers, resend, runErrors);
  // 5. Reminder Free Trial in scadenza
  await checkTrialScadenza(base, headers, resend, runErrors);

  // 6. Alert admin: UNA sola email aggregata se restano errori dopo il retry.
  // Copre tutti i rami (promemoria, turni, trial). Niente retry sull'alert
  // stesso: se fallisce resta il console.error nei Runtime Log.
  if (runErrors.length) {
    try {
      const { error: alertErr } = await resend.emails.send({
        from:    'noreply@delphi-med.com',
        to:      ['fb.castaldo@gmail.com'],
        subject: `[Delphi~Med] send-reminders: ${runErrors.length} error${runErrors.length === 1 ? 'e residuo' : 'i residui'} dopo retry`,
        html:    buildAlertHtml(runErrors)
      });
      if (alertErr) throw new Error(alertErr.message);
      console.log(`[send-reminders] alert admin inviato (${runErrors.length} errori)`);
    } catch (e) {
      console.error('[send-reminders] alert admin FALLITO:', e.message);
    }
  }

  return res.status(200).json({ processed: appointments.length, sent, errors, smsSent, smsErrors, alerted: runErrors.length, date: tomorrow });
}

// ── NOTIFICHE TURNI IN SCADENZA ──────────────────────────────────────────────

async function checkTurniScadenza(base, headers, resend, runErrors) {
  const todayUTC = getTodayUTC();
  const soglie = [
    { giorni: 60, data: addDaysToDateStr(todayUTC, 60), campo: 'notified_60d_at' },
    { giorni: 30, data: addDaysToDateStr(todayUTC, 30), campo: 'notified_30d_at' },
  ];
  for (const soglia of soglie) {
    await processScadenzaSoglia(base, headers, soglia, resend, runErrors);
  }
}

async function processScadenzaSoglia(base, headers, { giorni, data, campo }, resend, runErrors) {
  console.log(`[turni-scadenza] soglia ${giorni}d: processing (data target: ${data})`);
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
    runErrors.push({ ramo: `turni-${giorni}d`, ref: 'query turni', msg: e.message });
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

    const er = await sendEmailWithRetry(resend, {
      from:    'noreply@delphi-med.com',
      to:      [medico.email],
      subject,
      html
    });
    if (!er.ok) {
      console.error(`[turni-scadenza] soglia ${giorni}d medico ${medico.id}:`, er.error);
      // La query filtra su data_fine_validita puntuale che trasla ogni giorno:
      // per la soglia 60d la riga non sarà mai rivista (la 30d la riacchiappa
      // un mese dopo); per la 30d non c'è alcuna rete. Rimedio: alert admin.
      runErrors.push({ ramo: `turni-${giorni}d`, ref: `medici.id ${medico.id}`, msg: er.error });
      continue;
    }
    try {
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
      // Email GIÀ inviata: qui falliscono solo PATCH/audit. Non si ritenta
      // l'invio (doppione) — si registra per l'alert admin.
      console.error(`[turni-scadenza] soglia ${giorni}d medico ${medico.id} post-invio:`, e.message);
      runErrors.push({ ramo: `turni-${giorni}d-postinvio`, ref: `medici.id ${medico.id}`, msg: e.message });
    }
  }

  // d) Log finale
  console.log(`[turni-scadenza] soglia ${giorni}d: ${emailInviate} email inviate, ${turniNotificati} turni notificati`);
}

// ── REMINDER FREE TRIAL IN SCADENZA ──────────────────────────────────────────

async function checkTrialScadenza(base, headers, resend, runErrors) {
  // Soglia: account creato >= 41 giorni fa (trial di 45gg, avviso ~4gg prima)
  const isoSoglia = new Date(Date.now() - 41 * 24 * 60 * 60 * 1000).toISOString();

  // a) Medici in trial (free) in scadenza, non ancora avvisati
  let medici;
  try {
    const r = await fetch(
      `${base}/medici?piano=eq.free&trial_reminder_sent_at=is.null&created_at=lte.${encodeURIComponent(isoSoglia)}&deleted_at=is.null&select=id,email,created_at`,
      { headers }
    );
    if (!r.ok) throw new Error(`query medici ${r.status}`);
    medici = await r.json();
  } catch (e) {
    console.error('[send-reminders] trial reminder query medici:', e.message);
    return;
  }

  if (!medici.length) {
    console.log('[send-reminders] nessun trial in scadenza');
    return;
  }

  let emailInviate = 0;

  // b) Invia il reminder e marca solo dopo invio riuscito (dedup)
  for (const medico of medici) {
    if (!medico.email) continue;

    const subject = 'Il tuo periodo di prova Delphi~Med sta per scadere';
    const html = buildTrialScadenzaHtml();

    const er = await sendEmailWithRetry(resend, {
      from:    'noreply@delphi-med.com',
      to:      [medico.email],
      subject,
      html
    });
    if (!er.ok) {
      console.error('[send-reminders] trial reminder error:', er.error);
      // Qui la query (created_at lte + flag is.null) rivede DAVVERO la riga
      // alla prossima run — l'alert copre comunque anche questo ramo.
      runErrors.push({ ramo: 'trial', ref: `medici.id ${medico.id}`, msg: er.error });
      continue;
    }
    try {
      // Aggiorna trial_reminder_sent_at solo se email OK
      await fetch(`${base}/medici?id=eq.${medico.id}`, {
        method:  'PATCH',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body:    JSON.stringify({ trial_reminder_sent_at: new Date().toISOString() })
      });
      emailInviate++;
    } catch (e) {
      console.error('[send-reminders] trial reminder post-invio:', e.message);
      runErrors.push({ ramo: 'trial-postinvio', ref: `medici.id ${medico.id}`, msg: e.message });
    }
  }

  console.log(`[send-reminders] trial reminder: ${emailInviate} email inviate`);
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

// 'YYYY-MM-DD' → 'DD/MM'. Split della stringa (niente Date locale-dipendente).
// Da NON usare formatDateIt per l'SMS: contiene accenti (non GSM-7).
function formatDateShort(dateStr) {
  const [, m, d] = String(dateStr || '').split('-');
  return (d && m) ? `${d}/${m}` : String(dateStr || '');
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
    const giorno = GIORNI_IT[t.giorno] || '';
    const inizio = (t.inizio || '').substring(0, 5);
    const fine   = (t.fine   || '').substring(0, 5);
    const scadenza = formatDateIt(t.data_fine_validita);
    const centroNome = esc(t.centro_nome || '—');
    return `<tr><td style="padding:8px 0;border-bottom:1px solid #e2edf8;font-size:14px;color:#111;">&#8226; Centro <strong>${centroNome}</strong>: ${esc(giorno)} ${esc(inizio)}&ndash;${esc(fine)}, scadenza <strong>${esc(scadenza)}</strong></td></tr>`;
  }).join('');
  const cardInner =
    `<tr><td style="padding:0 0 12px;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#666;font-weight:600;">Turni in scadenza</td></tr>` +
    turniRows;
  const body =
    emailTitle('Promemoria scadenza turno') +
    `<p style="font-size:16px;color:#1a1a1a;margin:0 0 12px;">Ciao <strong>${esc(nomeCompleto)}</strong>,</p>` +
    `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 24px;">questo &egrave; un promemoria automatico: hai <strong>${n} turn${n === 1 ? 'o' : 'i'} ricorrent${n === 1 ? 'e' : 'i'}</strong> in scadenza tra <strong>${giorni} giorni</strong>.</p>` +
    detailCard(cardInner) +
    noteBox('<strong>Cosa succede a scadenza</strong><br>&bull; Il turno non generer&agrave; pi&ugrave; nuovi slot prenotabili<br>&bull; Gli appuntamenti gi&agrave; prenotati restano in agenda') +
    `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 8px;">Se vuoi prorogare o modificare la scadenza, accedi a <strong>Delphi~Med &rarr; Centri</strong> e clicca il bottone calendario sul turno interessato.</p>` +
    `<p style="font-size:14px;color:#555;margin:0;">Buon lavoro,<br><strong>Delphi~Med</strong></p>`;
  return emailShell(body);
}

function buildTrialScadenzaHtml() {
  const body =
    emailTitle('Il tuo periodo di prova sta per scadere') +
    `<p style="font-size:16px;color:#1a1a1a;margin:0 0 12px;">Gentile Dottoressa, Gentile Dottore,</p>` +
    `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 20px;">la tua <strong>prova gratuita di 45 giorni</strong> di Delphi~Med sta per terminare. Ci auguriamo che questo periodo ti abbia permesso di apprezzare come Delphi~Med possa semplificare la gestione della tua attivit&agrave;.</p>` +
    `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 20px;">Per continuare a usare Delphi~Med <strong>senza interruzioni</strong>, ti invitiamo a passare a un piano a pagamento prima della scadenza.</p>` +
    ctaButton('https://delphi-med.com', 'Vai a Delphi~Med') +
    `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 8px;">Accedi al tuo account e apri la pagina <strong>Piani</strong> per scegliere l&rsquo;abbonamento pi&ugrave; adatto alle tue esigenze.</p>` +
    `<p style="font-size:14px;color:#555;margin:0;">A presto,<br><strong>Delphi~Med</strong></p>`;
  return emailShell(body);
}

// Alert admin: elenco errori residui. SOLO id etichettati ed error message,
// nessun dato personale di pazienti o medici.
function buildAlertHtml(runErrors) {
  const rows = runErrors.map(x =>
    `<tr><td style="padding:6px 0;border-bottom:1px solid #e2edf8;font-size:13px;color:#111;"><strong>${esc(x.ramo)}</strong> &mdash; ${esc(x.ref)}: ${esc(x.msg)}</td></tr>`
  ).join('');
  const body =
    emailTitle('send-reminders: errori residui') +
    `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 16px;">La run del cron ha registrato <strong>${runErrors.length} error${runErrors.length === 1 ? 'e' : 'i'}</strong> ancora present${runErrors.length === 1 ? 'e' : 'i'} dopo il ritentativo in-run. Dettagli completi nei Runtime Log di Vercel.</p>` +
    detailCard(rows);
  return emailShell(body);
}

// SMS promemoria: GSM-7, sotto 160 caratteri, senza tipo_visita/area_tematica.
// Nessun accento, nessuna tilde (Delphi-Med, non Delphi~Med).
function buildReminderSms({ medicoNome, dataShort, ora, centroNome }) {
  const centro = centroNome || 'il centro';
  const build = c => `Promemoria: visita domani ${dataShort} alle ${ora} con ${medicoNome} presso ${c}. Delphi-Med`;
  let text = build(centro);
  if (text.length > 155) {
    const overflow = text.length - 155;
    const trimmed = centro.slice(0, Math.max(0, centro.length - overflow)).trimEnd();
    text = build(trimmed);
  }
  return text;
}

function buildReminderHtml({ pazienteNome, medicoNome, dataFmt, ora, tipoVisita, centroNome, centroIndirizzo }) {
  const centroVal = `${esc(centroNome || '—')}` + (centroIndirizzo ? `<br><span style="color:#555;font-size:13px;font-weight:400;">${esc(centroIndirizzo)}</span>` : '');
  const rows =
    detailRow('Medico', esc(medicoNome)) +
    detailRow('Data', esc(dataFmt)) +
    detailRow('Ora', esc(ora || '—')) +
    (tipoVisita ? detailRow('Tipo visita', esc(tipoVisita)) : '') +
    detailRow('Centro', centroVal, { last: true });
  const body =
    emailTitle('Promemoria visita') +
    `<p style="font-size:16px;color:#1a1a1a;margin:0 0 12px;">Gentile <strong>${esc(pazienteNome)}</strong>,</p>` +
    `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 28px;">ti ricordiamo che hai una visita prenotata <strong>domani</strong>.</p>` +
    detailCard(rows) +
    noteBox('<strong>Cosa portare alla visita</strong><br>Documentazione sanitaria (referti, esami precedenti, cartelle cliniche), tessera sanitaria, eventuali farmaci che assumi regolarmente, documento di identit&agrave; e ogni altro documento rilevante per la visita.') +
    `<p style="font-size:13px;color:#888;margin:0;">Per cancellare o modificare l&rsquo;appuntamento usa il codice di cancellazione ricevuto al momento della prenotazione.</p>`;
  return emailShell(body);
}
