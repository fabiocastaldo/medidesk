// lib/sospensione.js
// Avviso automatico al medico sospeso (s63, decisione di Fabio del 29/09/2026; V02 § 3-septiesdecies).
// La sospensione si esegue nel database (stato = 'sospeso' con sospensione_motivo obbligatorio per vincolo CHECK;
// sospeso_il lo scrive il trigger trg_medici_sospensione). Alla sospensione il trigger AFTER UPDATE
// trg_medici_sospensione_avviso accoda con pg_net una chiamata a /api/avviso-sospensione; il cron giornaliero
// (api/send-reminders) fa da rete di sicurezza. Entrambi chiamano avvisaSospensione, idempotente sulla coppia
// medico + sospeso_il (traccia 'sospensione_avvisata'): una sospensione successiva riceve la sua mail.
//
// Nella mail niente nomi ne' recapiti dei pazienti (passerebbero da Resend, conservazione negli USA): solo il numero
// degli appuntamenti gia' presi e la data del primo. L'elenco lo invia il gestore da privacy@delphi-med.com dopo
// aver verificato l'identita' del medico (il caso piu' probabile di sospensione e' l'account compromesso).
const P = t => `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 16px;">${t}</p>`;
const dataIt = s => { const [y, m, d] = String(s || '').slice(0, 10).split('-'); return d ? `${d}/${m}/${y}` : ''; };

export function mailSospensione({ nome, motivo, sospesoIl, n, primo }, { emailShell, emailTitle, esc }) {
  const app = n > 0
    ? `Hai <strong>${n}</strong> ${n === 1 ? 'appuntamento gi&agrave; preso' : 'appuntamenti gi&agrave; presi'} da oggi in poi, il primo il <strong>${dataIt(primo)}</strong>. Non potendo accedere al gestionale, per ricevere l&rsquo;elenco scrivi a <a href="mailto:privacy@delphi-med.com" style="color:#15487F;">privacy@delphi-med.com</a>: te lo invieremo dopo aver verificato la tua identit&agrave;. Avvisare i pazienti spetta a te.`
    : 'Non hai appuntamenti in calendario da oggi in poi.';
  return emailShell(
    emailTitle('Il tuo account &egrave; sospeso', { tone: 'danger' }) +
    `<p style="font-size:16px;color:#1a1a1a;margin:0 0 16px;">Gentile <strong>${nome}</strong>,</p>` +
    P(`il tuo account Delphi&#8288;~Med &egrave; stato sospeso il ${dataIt(sospesoIl)}. Motivo: <strong>${esc(motivo)}</strong>.`) +
    P('Da questo momento non puoi accedere al gestionale; la tua pagina pubblica non &egrave; visibile e non ricevi prenotazioni online; i promemoria automatici ai tuoi pazienti sono sospesi e i pazienti non possono rispondere ai messaggi. I tuoi dati e quelli dei tuoi pazienti restano integri e non sono usati per altro.') +
    P(app) +
    P('Per la gestione del caso, per chiedere l&rsquo;esportazione dei tuoi dati o se non riconosci il motivo della sospensione, scrivi a <a href="mailto:privacy@delphi-med.com" style="color:#15487F;">privacy@delphi-med.com</a>.')
  );
}

// Esito: 'inviato' | 'gia_avvisato' | 'non_sospeso'. Lancia in caso di errore (chi chiama lo registra).
export async function avvisaSospensione({ base, headers, resend, shell, medicoId, oggi = new Date().toISOString().slice(0, 10) }) {
  const r = await fetch(`${base}/medici?id=eq.${encodeURIComponent(medicoId)}` +
    '&select=id,email,titolo,nome,cognome,stato,sospeso_il,sospensione_motivo', { headers });
  if (!r.ok) throw new Error(`medici ${r.status}`);
  const m = (await r.json())[0];
  if (!m || m.stato !== 'sospeso' || !m.sospeso_il) return 'non_sospeso';
  if (!m.email) throw new Error('email assente');
  const t = await fetch(`${base}/audit_log?action=eq.sospensione_avvisata&medico_id=eq.${encodeURIComponent(m.id)}` +
    `&details->>sospeso_il=eq.${encodeURIComponent(m.sospeso_il)}&select=id&limit=1`, { headers });
  if (!t.ok) throw new Error(`audit_log ${t.status}`);
  if ((await t.json()).length) return 'gia_avvisato';
  const a = await fetch(`${base}/appuntamenti?medico_id=eq.${encodeURIComponent(m.id)}&data=gte.${oggi}` +
    '&or=(cancelled.is.null,cancelled.is.false)&select=data&order=data.asc&limit=1',
    { headers: { ...headers, 'Prefer': 'count=exact' } });
  if (!a.ok) throw new Error(`appuntamenti ${a.status}`);
  const primo = (await a.json())[0]?.data || null;
  const n = Number(String(a.headers.get('content-range') || '').split('/')[1]) || 0;
  const nome = shell.esc([m.titolo, m.nome, m.cognome].filter(Boolean).join(' ') || 'dottore');
  const { error } = await resend.emails.send({
    from: 'noreply@delphi-med.com', to: [m.email],
    subject: 'Delphi\u2060~Med — il tuo account è sospeso',
    html: mailSospensione({ nome, motivo: m.sospensione_motivo, sospesoIl: m.sospeso_il, n, primo }, shell)
  });
  if (error) throw new Error(`mail: ${error.message || error}`);
  const w = await fetch(`${base}/audit_log`, {
    method: 'POST', headers: { ...headers, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ medico_id: m.id, action: 'sospensione_avvisata', target_type: 'account', target_id: m.id,
      details: { sospeso_il: m.sospeso_il, n_appuntamenti: n } })
  });
  if (!w.ok) throw new Error(`traccia ${w.status}`);
  return 'inviato';
}

// Rete di sicurezza del cron: ogni medico sospeso senza traccia per la sospensione in corso.
export async function eseguiAvvisiSospensione({ supabaseUrl, supabaseKey, resend, shell, runErrors = [] }) {
  const base = `${supabaseUrl}/rest/v1`;
  const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };
  const esito = { sospesi: 0, inviati: 0, errori: 0 };
  try {
    const r = await fetch(`${base}/medici?stato=eq.sospeso&select=id&limit=200`, { headers });
    if (!r.ok) throw new Error(`medici ${r.status}`);
    for (const { id } of await r.json()) {
      esito.sospesi++;
      try { if ((await avvisaSospensione({ base, headers, resend, shell, medicoId: id })) === 'inviato') esito.inviati++; }
      catch (e) { esito.errori++; runErrors.push({ ramo: 'sospensione', ref: `medico ${id}`, msg: e.message }); }
    }
  } catch (e) { esito.errori++; runErrors.push({ ramo: 'sospensione', ref: 'query', msg: e.message }); }
  console.log('[sospensione]', JSON.stringify(esito));
  return esito;
}
