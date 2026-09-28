// lib/uscita.js
// Uscita del medico alla cessazione (s59, 28/09/2026; piano privacy righe 43-44; DPA art. 9, Termini art. 10,
// Policy di conservazione § 4, informativa medici). Chiamato una volta al giorno da api/send-reminders (cron Vercel).
//
// Cessazione = piano 'free' oltre la più tarda fra fine prova (created_at + 45 giorni, come lib/trial-gate.js) e
// fine dell'ultimo periodo pagato (current_period_end). Stessa regola di public.medico_in_servizio nel database,
// che spegne pagina pubblica e prenotazioni 7 giorni dopo la cessazione.
//
// Sequenza, per ogni cessazione (chiave = istante di cessazione, così una riattivazione seguita da una nuova
// cessazione riparte da capo):
//   giorno 0  mail di avviso: pagina spenta dal giorno 7, dati consultabili ed esportabili fino alla scadenza
//             (giorno dell'avviso + 30 giorni), cancellazione dalla scadenza, riattivazione possibile.
//             Traccia 'uscita_avviso' con cessazione_at e scadenza: da qui in poi la scadenza è quella scritta.
//   scadenza - 7 giorni  mail di promemoria, traccia 'uscita_promemoria'.
//   scadenza  cancellazione definitiva con la procedura di lib/elimina-account.js (abbonamento, file, utente Auth,
//             cascata, verifica, traccia con soli conteggi) e mail di conferma; solo se il promemoria è partito
//             da almeno 6 giorni.
// Una mail non partita non lascia traccia e si riprova al giro successivo (l'errore va nell'alert admin): senza
// avviso e promemoria inviati non si cancella nulla. Chi sceglie o rinnova un piano esce dal perimetro (piano
// diverso da 'free') e non perde nulla. I medici con eliminazione su richiesta in corso seguono lib/elimina-account.js.
import { contaRighe, cancellaFile, annullaAbbonamento } from './elimina-account.js';

const G = 86400000;
export const GIORNI_PROVA = 45;
export const GIORNI_PAGINA = 7;
export const GIORNI_USCITA = 30;
export const GIORNI_PROMEMORIA = 7;
export const MAX_CANCELLAZIONI_PER_GIRO = 5;

export function cessazione(m) {
  if (!m || m.piano !== 'free') return null;
  const creato = Date.parse(m.created_at);
  if (!Number.isFinite(creato)) return null;           // come trial-gate: dato malformato = nessuna cessazione
  const fineProva = creato + GIORNI_PROVA * G;
  const finePagato = m.current_period_end ? Date.parse(m.current_period_end) : creato;
  const ms = Math.max(fineProva, Number.isFinite(finePagato) ? finePagato : creato);
  return { ms, iso: new Date(ms).toISOString(), tipo: Number.isFinite(finePagato) && finePagato > fineProva ? 'abbonamento' : 'prova' };
}

const giornoIso = ms => new Date(ms).toISOString().slice(0, 10);
export const dataIt = ms => { const d = new Date(ms); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; };

const ELENCO = 'pazienti, visite, referti, appuntamenti e centri';
const ESPORTA = 'da <strong>Impostazioni</strong> &rarr; <strong>Esporta dati</strong> &rarr; <strong>Scarica backup completo (ZIP)</strong>';
const P = t => `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 16px;">${t}</p>`;

export function mailAvviso({ nome, tipo, cessMs, paginaMs, scadenzaMs, now }, { emailShell, emailTitle, ctaButton }) {
  const cosa = tipo === 'abbonamento' ? 'il tuo abbonamento a Delphi&#8288;~Med &egrave; terminato' : 'il tuo periodo di prova di Delphi&#8288;~Med &egrave; terminato';
  const pagina = paginaMs > now
    ? `Dal <strong>${dataIt(paginaMs)}</strong> la tua pagina pubblica non sar&agrave; pi&ugrave; visibile e non riceverai pi&ugrave; prenotazioni online, n&eacute; dalla pagina n&eacute; dal link del centro n&eacute; dalle organizzazioni.`
    : 'La tua pagina pubblica non &egrave; pi&ugrave; visibile e non ricevi pi&ugrave; prenotazioni online, n&eacute; dalla pagina n&eacute; dal link del centro n&eacute; dalle organizzazioni.';
  return emailShell(
    emailTitle('Cosa succede ai tuoi dati', { tone: 'danger' }) +
    `<p style="font-size:16px;color:#1a1a1a;margin:0 0 16px;">Gentile <strong>${nome}</strong>,</p>` +
    P(`${cosa} il ${dataIt(cessMs)}.`) + P(pagina) +
    P(`I dati che hai inserito (${ELENCO}) restano consultabili fino al <strong>${dataIt(scadenzaMs - G)}</strong>: puoi accedere ed esportarli ${ESPORTA}.`) +
    P(`Dal <strong>${dataIt(scadenzaMs)}</strong> cancelleremo in modo definitivo il tuo account e tutti i dati collegati. Una settimana prima ti invieremo un promemoria.`) +
    P('Se scegli o rinnovi un piano prima di quella data non perdi nulla e la tua pagina torna subito attiva.') +
    ctaButton('https://www.delphi-med.com', 'Vai a Delphi~Med') +
    `<p style="font-size:13px;color:#888;margin:0;">Per qualsiasi domanda: <a href="https://www.delphi-med.com/assistenza" style="color:#888;">www.delphi-med.com/assistenza</a>.</p>`
  );
}

export function mailPromemoria({ nome, scadenzaMs }, { emailShell, emailTitle, ctaButton }) {
  return emailShell(
    emailTitle('Tra 7 giorni cancelleremo i tuoi dati', { tone: 'danger' }) +
    `<p style="font-size:16px;color:#1a1a1a;margin:0 0 16px;">Gentile <strong>${nome}</strong>,</p>` +
    P(`dal <strong>${dataIt(scadenzaMs)}</strong> cancelleremo in modo definitivo il tuo account Delphi&#8288;~Med e tutti i dati collegati (${ELENCO}).`) +
    P(`Se vuoi conservarne una copia, esportali ora ${ESPORTA}.`) +
    P('Se scegli o rinnovi un piano prima di quella data non perdi nulla e la tua pagina torna subito attiva.') +
    ctaButton('https://www.delphi-med.com', 'Vai a Delphi~Med') +
    `<p style="font-size:13px;color:#888;margin:0;">Per qualsiasi domanda: <a href="https://www.delphi-med.com/assistenza" style="color:#888;">www.delphi-med.com/assistenza</a>.</p>`
  );
}

export function mailCancellato({ nome, tipo }, { emailShell, emailTitle }) {
  const cosa = tipo === 'abbonamento' ? 'del tuo abbonamento' : 'del tuo periodo di prova';
  return emailShell(
    emailTitle('Account e dati cancellati', { tone: 'danger' }) +
    `<p style="font-size:16px;color:#1a1a1a;margin:0 0 16px;">Gentile <strong>${nome}</strong>,</p>` +
    P(`come annunciato, trascorsi i 30 giorni dalla fine ${cosa}, abbiamo eliminato il tuo account Delphi&#8288;~Med: profilo, pazienti, visite, appuntamenti, documenti e referti archiviati. L&rsquo;accesso non &egrave; pi&ugrave; possibile.`) +
    P('Conserviamo soltanto la prova dell&rsquo;accettazione dei contratti e i registri tecnici, per le durate indicate nell&rsquo;informativa. Eventuali copie di sicurezza del database vengono sovrascritte nel loro ciclo ordinario.') +
    `<p style="font-size:13px;color:#888;margin:0;">Per qualsiasi domanda: <a href="mailto:privacy@delphi-med.com" style="color:#888;">privacy@delphi-med.com</a>.</p>`
  );
}

async function traccia(base, headers, medicoId, targetId, action, details) {
  const r = await fetch(`${base}/audit_log`, {
    method: 'POST', headers: { ...headers, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ medico_id: medicoId, action, target_type: 'account', target_id: targetId, details })
  });
  if (!r.ok) throw new Error(`audit ${action} ${r.status}`);
}

export async function eseguiUscita({ supabaseUrl, supabaseKey, stripeKey, resend, shell, runErrors = [], now = Date.now() }) {
  const base = `${supabaseUrl}/rest/v1`;
  const storageBase = `${supabaseUrl}/storage/v1`;
  const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };
  const esito = { cessati: 0, avvisi: 0, promemoria: 0, cancellati: 0, errori: 0 };

  let lista;
  try {
    const r = await fetch(`${base}/medici?stato=eq.approvato&deleted_at=is.null&piano=eq.free` +
      `&select=id,user_id,email,titolo,nome,cognome,piano,created_at,current_period_end&order=created_at.asc&limit=500`, { headers });
    if (!r.ok) throw new Error(`medici ${r.status}`);
    lista = await r.json();
    if (!Array.isArray(lista)) throw new Error('lettura medici non valida');
  } catch (e) {
    runErrors.push({ ramo: 'uscita', ref: 'query', msg: e.message });
    esito.errori++;
    return esito;
  }

  for (const m of lista) {
    const c = cessazione(m);
    if (!c || now < c.ms) continue;
    esito.cessati++;
    try {
      const nome = shell.esc([m.titolo, m.nome, m.cognome].filter(Boolean).join(' ') || 'dottore');
      const a = await fetch(`${base}/audit_log?medico_id=eq.${encodeURIComponent(m.id)}&action=in.(uscita_avviso,uscita_promemoria)` +
        `&select=action,details,created_at&order=created_at.desc&limit=50`, { headers });
      if (!a.ok) throw new Error(`audit_log ${a.status}`);
      const tracce = (await a.json()).filter(x => x.details && x.details.cessazione_at === c.iso);
      const avviso = tracce.find(x => x.action === 'uscita_avviso');
      const prom = tracce.find(x => x.action === 'uscita_promemoria');

      if (!avviso) {
        if (!m.email) throw new Error('email assente');
        const scadenzaMs = Date.parse(giornoIso(now + GIORNI_USCITA * G) + 'T00:00:00Z');
        const paginaMs = c.ms + GIORNI_PAGINA * G;
        const { error } = await resend.emails.send({
          from: 'noreply@delphi-med.com', to: [m.email],
          subject: 'Delphi\u2060~Med — cosa succede ai tuoi dati',
          html: mailAvviso({ nome, tipo: c.tipo, cessMs: c.ms, paginaMs, scadenzaMs, now }, shell)
        });
        if (error) throw new Error(`mail avviso: ${error.message || error}`);
        await traccia(base, headers, m.id, m.id, 'uscita_avviso',
          { cessazione_at: c.iso, tipo: c.tipo, pagina_spenta_da: new Date(paginaMs).toISOString(), scadenza: giornoIso(scadenzaMs) });
        esito.avvisi++;
        continue;
      }

      const scadenzaMs = Date.parse(avviso.details.scadenza + 'T00:00:00Z');
      if (!Number.isFinite(scadenzaMs)) throw new Error('scadenza non valida nella traccia di avviso');

      if (!prom) {
        if (now < scadenzaMs - GIORNI_PROMEMORIA * G) continue;
        if (!m.email) throw new Error('email assente');
        const { error } = await resend.emails.send({
          from: 'noreply@delphi-med.com', to: [m.email],
          subject: 'Delphi\u2060~Med — tra 7 giorni cancelleremo i tuoi dati',
          html: mailPromemoria({ nome, scadenzaMs }, shell)
        });
        if (error) throw new Error(`mail promemoria: ${error.message || error}`);
        await traccia(base, headers, m.id, m.id, 'uscita_promemoria', { cessazione_at: c.iso, scadenza: avviso.details.scadenza });
        esito.promemoria++;
        continue;
      }

      if (now < scadenzaMs || now < Date.parse(prom.created_at) + 6 * G) continue;
      if (esito.cancellati >= MAX_CANCELLAZIONI_PER_GIRO) continue;
      if (!m.user_id) throw new Error('user_id assente');

      const conteggi = {};
      for (const t of ['pazienti', 'visite', 'appuntamenti']) conteggi[`n_${t}`] = await contaRighe(base, headers, t, m.id);
      const abbonamento = await annullaAbbonamento(base, headers, m.id, stripeKey);
      const nFile = await cancellaFile(storageBase, headers, m.user_id);
      const d = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(m.user_id)}`, { method: 'DELETE', headers });
      if (!d.ok && d.status !== 404) throw new Error(`auth delete ${d.status}`);
      if (d.status === 404) {
        const dm = await fetch(`${base}/medici?id=eq.${m.id}`, { method: 'DELETE', headers });
        if (!dm.ok) throw new Error(`medici delete ${dm.status}`);
      }
      const v = await fetch(`${base}/medici?id=eq.${m.id}&select=id`, { headers });
      if (!v.ok || (await v.json()).length) throw new Error('riga medici ancora presente dopo la cancellazione');
      await traccia(base, headers, null, m.id, 'account_eliminato',
        { motivo: 'cessazione', cessazione_at: c.iso, tipo: c.tipo, scadenza: avviso.details.scadenza,
          eseguita_at: new Date(now).toISOString(), ...conteggi, n_file: nFile, abbonamento })
        .catch(e => console.error('[uscita] traccia cancellazione:', e.message));
      if (m.email) {
        await resend.emails.send({
          from: 'noreply@delphi-med.com', to: [m.email],
          subject: 'Account Delphi\u2060~Med — dati cancellati',
          html: mailCancellato({ nome, tipo: c.tipo }, shell)
        }).catch(() => {});
      }
      esito.cancellati++;
    } catch (e) {
      esito.errori++;
      runErrors.push({ ramo: 'uscita', ref: `medico ${m.id}`, msg: e.message });
      console.error('[uscita]', m.id, e.message);
    }
  }
  console.log('[uscita]', JSON.stringify(esito));
  return esito;
}
