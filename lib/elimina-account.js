// lib/elimina-account.js
// Esecutore delle eliminazioni account programmate (s52, 25/09/2026).
// Chiamato una volta al giorno da api/send-reminders (cron Vercel).
//
// Il medico chiede l'eliminazione da Impostazioni → Zona pericolosa: il client scrive
// medici.deleted_at (ora) e deletion_scheduled_at (+30 giorni). Da quel momento i 30 giorni
// servono per ripensarci (banner «Annulla») e per esportare i dati. Qui si esegue la
// cancellazione vera, solo se ENTRAMBE le condizioni sono vere:
//   - deletion_scheduled_at è scaduta;
//   - deleted_at è più vecchia di 30 giorni (il medico, o chi ne ruba la sessione,
//     non può accorciare il periodo scrivendo una data nel passato).
//
// Ordine, per ogni medico:
//   1. abbonamento Stripe ancora attivo → annullato;
//   2. file nei bucket fotoreferti, fotoprofilo, import-agenda (prefisso = user_id) → cancellati
//      e verificati (i file NON seguono la cascata del database);
//   3. utente Auth → cancellato: la FK medici.user_id ON DELETE CASCADE porta via il profilo e,
//      a cascata, pazienti, visite, appuntamenti, centri, turni, messaggi e il resto;
//      audit_log resta con medico_id NULL, accettazioni_legali resta (nessuna FK, prova del contratto);
//   4. verifica che la riga medici non esista più;
//   5. traccia in audit_log (solo conteggi, nessun dato personale) e mail di conferma al medico.
// Un errore nei passi 1-2 ferma quel medico senza cancellare nulla dal database: si riprova alla
// run successiva e l'errore finisce nell'alert admin.
import Stripe from 'stripe';

const GRAZIA_MS   = 30 * 86400000;
const BUCKETS     = ['fotoreferti', 'fotoprofilo', 'import-agenda'];
const MAX_PER_RUN = 5;
const SUB_VIVE    = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'];

async function contaRighe(base, headers, tabella, medicoId) {
  const r = await fetch(`${base}/${tabella}?medico_id=eq.${medicoId}&select=id`, {
    method: 'HEAD', headers: { ...headers, 'Prefer': 'count=exact' }
  });
  const cr = r.headers.get('content-range') || '';
  const n = parseInt(cr.split('/')[1], 10);
  return Number.isFinite(n) ? n : null;
}

// Elenca ricorsivamente gli oggetti sotto un prefisso (le cartelle hanno id null).
async function elencaOggetti(storageBase, headers, bucket, prefix, out, depth = 0) {
  if (depth > 4) throw new Error(`storage ${bucket}: profondità inattesa`);
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${storageBase}/object/list/${bucket}`, {
      method: 'POST', headers,
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } })
    });
    if (!r.ok) throw new Error(`storage list ${bucket} ${r.status}`);
    const items = await r.json();
    for (const it of items) {
      const p = `${prefix}/${it.name}`;
      if (it.id === null) await elencaOggetti(storageBase, headers, bucket, p, out, depth + 1);
      else out.push(p);
    }
    if (items.length < 1000) break;
  }
  return out;
}

async function cancellaFile(storageBase, headers, userId) {
  let totale = 0;
  for (const bucket of BUCKETS) {
    const paths = await elencaOggetti(storageBase, headers, bucket, userId, []);
    for (let i = 0; i < paths.length; i += 1000) {
      const chunk = paths.slice(i, i + 1000);
      const r = await fetch(`${storageBase}/object/${bucket}`, {
        method: 'DELETE', headers, body: JSON.stringify({ prefixes: chunk })
      });
      if (!r.ok) throw new Error(`storage delete ${bucket} ${r.status}`);
    }
    const resto = await elencaOggetti(storageBase, headers, bucket, userId, []);
    if (resto.length) throw new Error(`storage ${bucket}: ${resto.length} file ancora presenti`);
    totale += paths.length;
  }
  return totale;
}

async function annullaAbbonamento(base, headers, medicoId, stripeKey) {
  const r = await fetch(`${base}/subscriptions?medico_id=eq.${medicoId}&select=stripe_subscription_id,status`, { headers });
  if (!r.ok) throw new Error(`subscriptions ${r.status}`);
  const sub = (await r.json())[0];
  if (!sub || !sub.stripe_subscription_id || !SUB_VIVE.includes(sub.status)) return 'nessuno';
  if (!stripeKey) throw new Error('abbonamento attivo ma STRIPE_SECRET_KEY assente');
  try {
    await new Stripe(stripeKey).subscriptions.cancel(sub.stripe_subscription_id);
  } catch (e) {
    if (e && e.code === 'resource_missing') return 'già assente su Stripe';
    throw new Error(`stripe cancel: ${e.message}`);
  }
  return 'annullato';
}

function htmlConferma(nome, { emailShell, emailTitle }) {
  return emailShell(
    emailTitle('Eliminazione account completata', { tone: 'danger' }) +
    `<p style="font-size:16px;color:#1a1a1a;margin:0 0 16px;">Gentile <strong>${nome}</strong>,</p>` +
    `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 16px;">trascorsi i 30 giorni dalla tua richiesta, abbiamo eliminato il tuo account Delphi~Med: profilo, pazienti, visite, appuntamenti, documenti e referti archiviati. L&rsquo;accesso non &egrave; pi&ugrave; possibile.</p>` +
    `<p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 16px;">Conserviamo soltanto la prova dell&rsquo;accettazione dei contratti e i registri tecnici, per le durate indicate nell&rsquo;informativa. Eventuali copie di sicurezza del database vengono sovrascritte nel loro ciclo ordinario.</p>` +
    `<p style="font-size:13px;color:#888;margin:0;">Per qualsiasi domanda: <a href="mailto:privacy@delphi-med.com" style="color:#888;">privacy@delphi-med.com</a>.</p>`
  );
}

export async function eseguiEliminazioniAccount({ supabaseUrl, supabaseKey, stripeKey, resend, shell, runErrors, now = Date.now() }) {
  const base = `${supabaseUrl}/rest/v1`;
  const storageBase = `${supabaseUrl}/storage/v1`;
  const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };
  const soglia = new Date(now - GRAZIA_MS).toISOString();
  const adesso = new Date(now).toISOString();
  const esito = { candidati: 0, eliminati: 0, errori: 0 };

  let lista;
  try {
    const r = await fetch(`${base}/medici?deleted_at=lt.${encodeURIComponent(soglia)}&deletion_scheduled_at=lte.${encodeURIComponent(adesso)}` +
      `&select=id,user_id,email,titolo,nome,cognome,deleted_at&order=deleted_at.asc&limit=${MAX_PER_RUN}`, { headers });
    if (!r.ok) throw new Error(`medici ${r.status}`);
    lista = await r.json();
  } catch (e) {
    runErrors.push({ ramo: 'elimina-account', ref: 'query', msg: e.message });
    return esito;
  }
  esito.candidati = lista.length;

  for (const m of lista) {
    try {
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

      await fetch(`${base}/audit_log`, {
        method: 'POST', headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          medico_id: null, action: 'account_eliminato', target_type: 'account', target_id: m.id,
          details: { richiesta_at: m.deleted_at, eseguita_at: new Date().toISOString(), ...conteggi, n_file: nFile, abbonamento }
        })
      }).catch(() => {});

      if (resend && shell && m.email) {
        const nome = shell.esc([m.titolo, m.nome, m.cognome].filter(Boolean).join(' ') || 'dottore');
        await resend.emails.send({
          from: 'noreply@delphi-med.com', to: [m.email],
          subject: 'Account Delphi⁠~Med — eliminazione completata',
          html: htmlConferma(nome, shell)
        }).catch(() => {});
      }
      esito.eliminati++;
    } catch (e) {
      esito.errori++;
      runErrors.push({ ramo: 'elimina-account', ref: `medico ${m.id}`, msg: e.message });
    }
  }
  return esito;
}
