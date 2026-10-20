// lib/avvisi-testi.js
// Ramo del cron (api/send-reminders): avvisi ai medici sulle nuove versioni sostanziali dei testi legali
// (Termini art. 11: preavviso di almeno 30 giorni e accettazione espressa) e avvisi di servizio (art. 6:
// manutenzione programmata con 48 ore di preavviso). s84, 20/10/2026; piano righe 22 e 76.
// Per ogni medico approvato e non in cancellazione: per ogni documento sostanziale non ancora accettato, una
// sola email di avviso per impronta (traccia avviso_testi_legali {documento, hash, fase, decorrenza}) e un solo
// promemoria negli ultimi PROMEMORIA_GIORNI; dopo la decorrenza niente email (il blocco all'ingresso parla da
// sé). Per ogni avviso di servizio attivo, una sola email per medico e per `id` (traccia avviso_servizio).
// Dedupe su audit_log, come l'uscita; destinatario pseudonimo nelle tracce. Al più MAX_EMAIL_PER_GIRO per giro:
// il resto riprende domani. Ogni errore finisce in runErrors (alert admin) e in esito.errori.
import { TESTI_VIGENTI, AVVISI_SERVIZIO, statoAccettazioni, faseAvviso, avvisiAttivi, dataIt } from './testi-vigenti.js';
import { pseudonimoRecapito } from './mailer.js';

export const MAX_EMAIL_PER_GIRO = 50;

export function mailAvvisoTesti({ nome, documenti, fase }, { emailShell, emailTitle, ctaButton, esc }) {
  const elenco = documenti.map(d => `<li><strong>${esc(d.nome)}</strong> (versione ${esc(d.versione)}), in vigore dal ${esc(dataIt(d.decorrenza))}</li>`).join('');
  const prima = documenti.map(d => d.decorrenza).sort()[0];
  const titolo = fase === 'promemoria' ? 'Tra pochi giorni servono le nuove accettazioni' : 'Nuove condizioni del servizio da accettare';
  const subject = fase === 'promemoria'
    ? `Delphi\u2060~Med — promemoria: nuove condizioni dal ${dataIt(prima)}`
    : `Delphi\u2060~Med — nuove condizioni del servizio dal ${dataIt(prima)}`;
  const html = emailShell(
    emailTitle(titolo) +
    `<p>Gentile ${nome},</p>` +
    `<p>abbiamo pubblicato una nuova versione di questi documenti, con modifiche di sostanza:</p><ul>${elenco}</ul>` +
    `<p>Fino alla data indicata restano valide per te le condizioni che hai già accettato. Da quella data, per continuare a usare il gestionale ti chiederemo di leggere e accettare la nuova versione; puoi farlo da subito dal gestionale. Se non accetti, i tuoi dati restano consultabili ed esportabili, ma non potrai registrare nuove attività.</p>` +
    ctaButton('https://www.delphi-med.com/medidesk.html', 'Apri il gestionale') +
    `<p style="font-size:13px;color:#888;">Il testo integrale di ogni versione è in Impostazioni → Documenti. Domande: <a href="mailto:privacy@delphi-med.com" style="color:#888;">privacy@delphi-med.com</a>.</p>`
  );
  return { subject, html };
}

export function mailAvvisoServizio({ nome, avviso }, { emailShell, emailTitle, esc }) {
  return {
    subject: `Delphi\u2060~Med — ${avviso.titolo}`,
    html: emailShell(emailTitle(esc(avviso.titolo)) + `<p>Gentile ${nome},</p><p>${esc(avviso.testo)}</p>` +
      `<p style="font-size:13px;color:#888;">Avviso di servizio ai sensi dei Termini (art. 6).</p>`)
  };
}

export async function eseguiAvvisiTesti({ supabaseUrl, supabaseKey, resend, shell, runErrors = [], now = Date.now(),
  testi = TESTI_VIGENTI, avvisi = AVVISI_SERVIZIO }) {
  const base = `${supabaseUrl}/rest/v1`;
  const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' };
  const esito = { medici: 0, avvisi_testi: 0, promemoria_testi: 0, avvisi_servizio: 0, rimasti: 0, errori: 0 };
  const sostanziali = Object.entries(testi).filter(([, t]) => t.sostanziale && t.decorrenza);
  const attivi = avvisiAttivi(now, avvisi);
  if (!sostanziali.length && !attivi.length) return esito;   // niente da annunciare: nessuna lettura
  let inviate = 0;
  try {
    const r = await fetch(`${base}/medici?stato=eq.approvato&deleted_at=is.null&deletion_scheduled_at=is.null&select=id,email,titolo,nome,cognome&order=created_at.asc&limit=500`, { headers });
    if (!r.ok) throw new Error(`medici ${r.status}`);
    const lista = await r.json();
    if (!Array.isArray(lista)) throw new Error('lettura medici non valida');
    for (const m of lista) {
      esito.medici++;
      if (!m.email) continue;
      const nome = shell.esc([m.titolo, m.nome, m.cognome].filter(Boolean).join(' ') || 'dottore');
      try {
        const [acc, tr] = await Promise.all([
          fetch(`${base}/accettazioni_legali?medico_id=eq.${m.id}&select=documento,hash_testo`, { headers }),
          fetch(`${base}/audit_log?medico_id=eq.${m.id}&action=in.(avviso_testi_legali,avviso_servizio)&select=action,details&order=created_at.desc&limit=100`, { headers })
        ]);
        if (!acc.ok || !tr.ok) throw new Error(`letture ${acc.status}/${tr.status}`);
        const accettazioni = await acc.json(); const tracce = await tr.json();
        const giaFatto = (action, chiave) => tracce.some(x => x.action === action && x.details && x.details.chiave === chiave);
        // Testi legali: una email per fase, con tutti i documenti di quella fase.
        const stato = statoAccettazioni(accettazioni, now, testi);
        for (const fase of ['avviso', 'promemoria']) {
          const docs = stato.da_accettare.filter(d => faseAvviso(d.decorrenza, now) === fase && !giaFatto('avviso_testi_legali', `${d.documento}:${d.hash.slice(0, 16)}:${fase}`));
          if (!docs.length) continue;
          if (inviate >= MAX_EMAIL_PER_GIRO) { esito.rimasti++; continue; }
          const { subject, html } = mailAvvisoTesti({ nome, documenti: docs, fase }, shell);
          const { data, error } = await resend.emails.send({ from: 'noreply@delphi-med.com', to: [m.email], subject, html });
          if (error) throw new Error(`email ${fase}: ${error.message}`);
          inviate++;
          for (const d of docs) {
            const a = await fetch(`${base}/audit_log`, { method: 'POST', headers, body: JSON.stringify({ medico_id: m.id, action: 'avviso_testi_legali', target_type: 'medico', target_id: m.id,
              details: { chiave: `${d.documento}:${d.hash.slice(0, 16)}:${fase}`, documento: d.documento, versione: d.versione, hash: d.hash, fase, decorrenza: d.decorrenza, to: pseudonimoRecapito(m.email), resend_id: data?.id || null } }) });
            if (!a.ok) throw new Error(`traccia avviso ${a.status} (email inviata: il giro dopo non la ripete solo se la traccia esiste)`);
          }
          if (fase === 'avviso') esito.avvisi_testi++; else esito.promemoria_testi++;
        }
        // Avvisi di servizio.
        for (const av of attivi) {
          if (giaFatto('avviso_servizio', av.id)) continue;
          if (inviate >= MAX_EMAIL_PER_GIRO) { esito.rimasti++; continue; }
          const { subject, html } = mailAvvisoServizio({ nome, avviso: av }, shell);
          const { data, error } = await resend.emails.send({ from: 'noreply@delphi-med.com', to: [m.email], subject, html });
          if (error) throw new Error(`email servizio ${av.id}: ${error.message}`);
          inviate++;
          const a = await fetch(`${base}/audit_log`, { method: 'POST', headers, body: JSON.stringify({ medico_id: m.id, action: 'avviso_servizio', target_type: 'medico', target_id: m.id,
            details: { chiave: av.id, titolo: av.titolo, dal: av.dal, al: av.al, to: pseudonimoRecapito(m.email), resend_id: data?.id || null } }) });
          if (!a.ok) throw new Error(`traccia servizio ${a.status}`);
          esito.avvisi_servizio++;
        }
      } catch (e) {
        esito.errori++; runErrors.push({ ramo: 'avvisi-testi', ref: `medici.id ${m.id}`, msg: e.message });
      }
    }
    if (esito.rimasti > 0) runErrors.push({ ramo: 'avvisi-testi', ref: 'rimasti', msg: `${esito.rimasti} avvisi oltre il limite del giro: ripresi domani` });
  } catch (e) {
    esito.errori++; runErrors.push({ ramo: 'avvisi-testi', ref: 'query', msg: e.message });
    console.error('[avvisi-testi]', e.message);
  }
  console.log('[avvisi-testi]', JSON.stringify(esito));
  return esito;
}
