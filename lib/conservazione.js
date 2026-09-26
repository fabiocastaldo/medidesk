// lib/conservazione.js
// Conservazione eseguibile (s55, 26/09/2026; piano privacy righe 42-43, Policy di conservazione rev2.3 § 2).
// Chiamato una volta al giorno da api/send-reminders (cron Vercel), dopo le eliminazioni account.
//
// Regole (decorrenze approvate dal gestore il 26/09/2026):
//   contatori antiabuso (rate_limits)            24 ore da window_start
//   token di conferma prenotazione (email_tokens) 24 ore dopo scadenza o uso
//   token di approvazione medico (approve_tokens) 24 ore dopo scadenza o uso (l'approvazione resta in medici)
//   codici adesione organizzazione (coop_codici)  24 ore dopo scadenza o uso (traccia nel log autorizzazioni)
//   link dei canali pazienti (token_thread)       24 ore dopo scadenza o revoca (i messaggi restano)
//   appuntamenti annullati                        6 mesi da cancelled_at
//   appuntamenti non annullati                    12 mesi dalla data della prestazione (le visite non si toccano)
//   lista d'attesa                                30 giorni dalla data dell'appuntamento collegato
//   agende importate (import_inbox + file)        7 giorni dopo conferma o scarto
// Fuori per scelta dichiarata: audit_log (prove da classificare prima dei 12 mesi), messaggi e canali
// (piano clinico A01), candidature non approvate, tabelle di GoTrue.
//
// Ogni regola: seleziona gli id (tetto MAX_PER_REGOLA per giro), cancella per id, riporta il conteggio.
// Nessun dato personale nei log: solo nomi delle regole e numeri. Una regola che fallisce non ferma le
// altre; l'errore va in runErrors (alert admin). Con dryRun conta senza cancellare.

const H24 = 86400000;
export const MAX_PER_REGOLA = 1000;
const iso = (ms) => new Date(ms).toISOString();
const giorno = (ms) => iso(ms).slice(0, 10);

export function regole(now = Date.now()) {
  const g1 = iso(now - H24);
  return [
    { nome: 'contatori_antiabuso', tabella: 'rate_limits', pk: 'id',
      filtro: `window_start=lt.${encodeURIComponent(g1)}` },
    { nome: 'token_conferma_prenotazione', tabella: 'email_tokens', pk: 'jti',
      filtro: `or=(expires_at.lt.${encodeURIComponent(g1)},used_at.lt.${encodeURIComponent(g1)})` },
    { nome: 'token_approvazione_medico', tabella: 'approve_tokens', pk: 'jti',
      filtro: `or=(expires_at.lt.${encodeURIComponent(g1)},used_at.lt.${encodeURIComponent(g1)})` },
    { nome: 'codici_organizzazione', tabella: 'coop_codici', pk: 'id',
      filtro: `or=(expires_at.lt.${encodeURIComponent(g1)},used_at.lt.${encodeURIComponent(g1)})` },
    { nome: 'link_canali_pazienti', tabella: 'token_thread', pk: 'token_hash',
      filtro: `or=(expires_at.lt.${encodeURIComponent(g1)},revocato_at.lt.${encodeURIComponent(g1)})` },
    { nome: 'appuntamenti_annullati_6_mesi', tabella: 'appuntamenti', pk: 'id',
      filtro: `cancelled=is.true&cancelled_at=lt.${encodeURIComponent(iso(now - 182 * H24))}` },
    { nome: 'appuntamenti_12_mesi', tabella: 'appuntamenti', pk: 'id',
      filtro: `or=(cancelled.is.null,cancelled.is.false)&data=lt.${giorno(now - 365 * H24)}` },
    { nome: 'lista_attesa_30_giorni', tabella: 'lista_attesa', pk: 'id',
      select: 'id,appuntamenti!inner(data)',
      filtro: `appuntamenti.data=lt.${giorno(now - 30 * H24)}` },
    { nome: 'agende_importate_7_giorni', tabella: 'import_inbox', pk: 'id', select: 'id,file_path',
      filtro: `stato=in.(confermata,scartata)&created_at=lt.${encodeURIComponent(iso(now - 7 * H24))}`,
      bucket: 'import-agenda' }
  ];
}

export async function eseguiConservazione({ supabaseUrl, supabaseKey, runErrors = [], dryRun = false, now = Date.now() }) {
  const base = `${supabaseUrl}/rest/v1`;
  const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };
  const esito = {};
  for (const r of regole(now)) {
    try {
      const sel = await fetch(`${base}/${r.tabella}?select=${r.select || r.pk}&${r.filtro}&limit=${MAX_PER_REGOLA}`, { headers });
      if (!sel.ok) throw new Error(`lettura ${sel.status}`);
      const righe = await sel.json();
      if (!Array.isArray(righe)) throw new Error('lettura non valida');
      if (!righe.length || dryRun) { esito[r.nome] = righe.length; continue; }
      if (r.bucket) {
        const paths = righe.map(x => x.file_path).filter(Boolean);
        if (paths.length) {
          const d = await fetch(`${supabaseUrl}/storage/v1/object/${r.bucket}`, {
            method: 'DELETE', headers, body: JSON.stringify({ prefixes: paths })
          });
          if (!d.ok) throw new Error(`storage ${d.status}`);
        }
      }
      let cancellate = 0;
      for (let i = 0; i < righe.length; i += 200) {
        const ids = righe.slice(i, i + 200).map(x => encodeURIComponent(x[r.pk]));
        const del = await fetch(`${base}/${r.tabella}?${r.pk}=in.(${ids.join(',')})&select=${r.pk}`, {
          method: 'DELETE', headers: { ...headers, 'Prefer': 'return=representation' }
        });
        if (!del.ok) throw new Error(`cancellazione ${del.status}`);
        cancellate += (await del.json().catch(() => [])).length;
      }
      esito[r.nome] = cancellate;
    } catch (e) {
      esito[r.nome] = 'errore';
      runErrors.push({ ramo: 'conservazione', ref: r.nome, msg: e.message });
      console.error(`[conservazione] ${r.nome}:`, e.message);
    }
  }
  // Traccia: la simulazione scrive sempre (prova che il giro è avvenuto e dei conteggi attesi);
  // l'esecuzione scrive solo se ha cancellato qualcosa.
  if (dryRun || Object.values(esito).some(v => typeof v === 'number' && v > 0)) {
    try {
      await fetch(`${base}/audit_log`, {
        method: 'POST', headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ action: dryRun ? 'conservazione_simulata' : 'conservazione_eseguita', target_type: 'sistema', details: esito })
      });
    } catch (e) { console.error('[conservazione] audit:', e.message); }
  }
  console.log('[conservazione]', dryRun ? 'simulazione' : 'eseguita', JSON.stringify(esito));
  return esito;
}
