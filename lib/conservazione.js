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
//   link dell'assistenza (assistenza_token)       24 ore dopo scadenza o revoca
//   conversazioni di assistenza                   12 mesi dalla chiusura (messaggi e link a cascata)
// Prima delle regole: le conversazioni di assistenza senza messaggi da 30 giorni sono chiuse
// d'ufficio (chiusa_da = 'sistema') e i loro link revocati (s57).
// Dopo le regole (s59, riga 43):
//   candidature non approvate (medici in_attesa)  90 giorni dalla registrazione o dall'ultimo esito
//                                                 negativo comunicato: file, utente Auth e cascata
//                                                 (lib/candidature.js), max 5 per giro
//   audit_log                                     12 mesi dall'evento, con la funzione DEFINER
//                                                 audit_purge_12_mesi (unico percorso ammesso dal
//                                                 trigger di protezione); sospesa con la variabile
//                                                 AUDIT_PURGE_SOSPESA=true (incidente documentato)
// Prima di audit_log (s60, riga 43):
//   prove del contratto (accettazioni_legali)     10 anni dalla cessazione (cessazione_at, timbrata dal
//                                                 trigger AFTER DELETE su medici), con la funzione
//                                                 DEFINER accettazioni_purge_10_anni (unico percorso
//                                                 ammesso dalla protezione a sola aggiunta)
// Fuori per scelta dichiarata: messaggi e canali (piano clinico A01), tabelle di GoTrue.
//
// Ogni regola: seleziona gli id (tetto MAX_PER_REGOLA per giro), cancella per id, riporta il conteggio.
// Nessun dato personale nei log: solo nomi delle regole e numeri. Una regola che fallisce non ferma le
// altre; l'errore va in runErrors (alert admin). Con dryRun conta senza cancellare.

import { eseguiCandidature } from './candidature.js';

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
      bucket: 'import-agenda' },
    { nome: 'link_assistenza', tabella: 'assistenza_token', pk: 'token_hash',
      filtro: `or=(expires_at.lt.${encodeURIComponent(g1)},revocato_at.lt.${encodeURIComponent(g1)})` },
    { nome: 'assistenza_12_mesi', tabella: 'assistenza_conversazioni', pk: 'id',
      filtro: `chiusa_at=lt.${encodeURIComponent(iso(now - 365 * H24))}` }
  ];
}

export async function eseguiConservazione({ supabaseUrl, supabaseKey, runErrors = [], dryRun = false, now = Date.now() }) {
  const base = `${supabaseUrl}/rest/v1`;
  const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };
  const esito = {};
  // Chiusura d'ufficio delle conversazioni di assistenza ferme da 30 giorni (s57).
  try {
    const soglia = encodeURIComponent(iso(now - 30 * H24));
    const filtro = `chiusa_at=is.null&ultimo_messaggio_at=lt.${soglia}`;
    if (dryRun) {
      const s = await fetch(`${base}/assistenza_conversazioni?select=id&${filtro}&limit=${MAX_PER_REGOLA}`, { headers });
      if (!s.ok) throw new Error(`lettura ${s.status}`);
      esito.assistenza_chiuse_30_giorni = (await s.json()).length;
    } else {
      const adesso = iso(now);
      const u = await fetch(`${base}/assistenza_conversazioni?${filtro}&select=id`, {
        method: 'PATCH', headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify({ chiusa_at: adesso, chiusa_da: 'sistema' })
      });
      if (!u.ok) throw new Error(`chiusura ${u.status}`);
      const chiuse = await u.json();
      for (let i = 0; i < chiuse.length; i += 200) {
        const ids = chiuse.slice(i, i + 200).map(x => encodeURIComponent(x.id));
        const v = await fetch(`${base}/assistenza_token?conversazione_id=in.(${ids.join(',')})&revocato_at=is.null`, {
          method: 'PATCH', headers: { ...headers, 'Prefer': 'return=minimal' }, body: JSON.stringify({ revocato_at: adesso })
        });
        if (!v.ok) throw new Error(`revoca ${v.status}`);
      }
      esito.assistenza_chiuse_30_giorni = chiuse.length;
    }
  } catch (e) {
    esito.assistenza_chiuse_30_giorni = 'errore';
    runErrors.push({ ramo: 'conservazione', ref: 'assistenza_chiuse_30_giorni', msg: e.message });
    console.error('[conservazione] assistenza_chiuse_30_giorni:', e.message);
  }
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
  // Candidature non approvate a 90 giorni (s59).
  try {
    esito.candidature_90_giorni = await eseguiCandidature({ supabaseUrl, headers, dryRun, now, runErrors });
  } catch (e) {
    esito.candidature_90_giorni = 'errore';
    runErrors.push({ ramo: 'conservazione', ref: 'candidature_90_giorni', msg: e.message });
    console.error('[conservazione] candidature_90_giorni:', e.message);
  }
  // Prove del contratto a 10 anni dalla cessazione (s60, riga 43).
  try {
    const d = new Date(now); d.setUTCFullYear(d.getUTCFullYear() - 10);
    if (dryRun) {
      const c = await fetch(`${base}/accettazioni_legali?select=id&cessazione_at=lt.${encodeURIComponent(d.toISOString())}`, {
        method: 'HEAD', headers: { ...headers, 'Prefer': 'count=exact' }
      });
      if (!c.ok) throw new Error(`conteggio ${c.status}`);
      const n = parseInt((c.headers.get('content-range') || '').split('/')[1], 10);
      if (!Number.isFinite(n)) throw new Error('conteggio non valido');
      esito.prove_contratto_10_anni = n;
    } else {
      const p = await fetch(`${base}/rpc/accettazioni_purge_10_anni`, { method: 'POST', headers, body: '{}' });
      if (!p.ok) throw new Error(`purga ${p.status}`);
      const n = await p.json();
      if (!Number.isInteger(n)) throw new Error('risposta della purga non valida');
      esito.prove_contratto_10_anni = n;
    }
  } catch (e) {
    esito.prove_contratto_10_anni = 'errore';
    runErrors.push({ ramo: 'conservazione', ref: 'prove_contratto_10_anni', msg: e.message });
    console.error('[conservazione] prove_contratto_10_anni:', e.message);
  }
  // audit_log a 12 mesi (s59): per ultima, così la traccia del giro nasce dopo la purga.
  try {
    if (process.env.AUDIT_PURGE_SOSPESA === 'true') {
      esito.audit_log_12_mesi = 'sospesa';
    } else if (dryRun) {
      const c = await fetch(`${base}/audit_log?select=id&created_at=lt.${encodeURIComponent(iso(now - 365 * H24))}`, {
        method: 'HEAD', headers: { ...headers, 'Prefer': 'count=exact' }
      });
      if (!c.ok) throw new Error(`conteggio ${c.status}`);
      const n = parseInt((c.headers.get('content-range') || '').split('/')[1], 10);
      if (!Number.isFinite(n)) throw new Error('conteggio non valido');
      esito.audit_log_12_mesi = n;
    } else {
      const p = await fetch(`${base}/rpc/audit_purge_12_mesi`, { method: 'POST', headers, body: '{}' });
      if (!p.ok) throw new Error(`purga ${p.status}`);
      const n = await p.json();
      if (!Number.isInteger(n)) throw new Error('risposta della purga non valida');
      esito.audit_log_12_mesi = n;
    }
  } catch (e) {
    esito.audit_log_12_mesi = 'errore';
    runErrors.push({ ramo: 'conservazione', ref: 'audit_log_12_mesi', msg: e.message });
    console.error('[conservazione] audit_log_12_mesi:', e.message);
  }
  // Traccia: la simulazione scrive sempre (prova che il giro è avvenuto e dei conteggi attesi);
  // l'esecuzione scrive solo se ha cancellato qualcosa.
  if (dryRun || Object.values(esito).some(v => typeof v === 'number' && v > 0)) {
    try {
      const r = await fetch(`${base}/audit_log`, {
        method: 'POST', headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ action: dryRun ? 'conservazione_simulata' : 'conservazione_eseguita', target_type: 'sistema', details: esito })
      });
      if (!r.ok) console.error('[conservazione] audit rifiutato:', r.status);
    } catch (e) { console.error('[conservazione] audit:', e.message); }
  }
  console.log('[conservazione]', dryRun ? 'simulazione' : 'eseguita', JSON.stringify(esito));
  return esito;
}
