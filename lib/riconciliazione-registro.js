// lib/riconciliazione-registro.js — B-09 (riesame grey box, s93, decisione del gestore).
// Le tracce automatiche del registro delle operazioni (audit_fascicolo, audit_referti_file, audit_mfa_fattori,
// audit_password) restano non bloccanti: se la scrittura della traccia fallisce l'operazione clinica prosegue.
// Ogni sera questo ramo del cron confronta, per le 24 ore precedenti, pazienti, visite, file dei referti e
// dispositivi della verifica in due passaggi creati con le rispettive tracce (RPC riconcilia_registro, solo
// service_role). Una traccia mancante diventa un avviso all'amministratore e una riga registro_discrepanza con i
// soli identificativi; un errore del ramo diventa riconciliazione_registro_fallita. Il cambio di password non e'
// riconciliabile (nessun dato oltre la traccia stessa): limite dichiarato in A02.
// Ripresa (s96, B-09): la finestra parte dalla fine dell'ultimo giro riuscito (riconciliazione_registro_eseguita o
// registro_discrepanza), non da 24 ore fisse, cosi' un giro fallito o saltato viene coperto dal successivo. Senza
// storia: 24 ore. Lettura dell'ultimo giro fallita: il ramo fallisce chiuso. Oltre 30 giorni: finestra troncata e avviso.
import { tracciaFallimento } from './registro-amministratori.js';

const H24 = 24 * 60 * 60 * 1000;
const MARGINE = 10 * 60 * 1000; // le scritture degli ultimi 10 minuti passano al giro successivo
const MAX_FINESTRA = 30 * H24;
const GIRI_RIUSCITI = ['riconciliazione_registro_eseguita', 'registro_discrepanza'];

// Fine dell'ultimo giro riuscito (ISO) o null se non ce n'e'; lancia se la lettura fallisce.
export async function fineUltimoGiro({ base, headers, fetchImpl = fetch }) {
  const r = await fetchImpl(`${base}/audit_log?action=in.(${GIRI_RIUSCITI.join(',')})&order=created_at.desc&limit=1&select=details`, { headers });
  if (!r.ok) throw new Error(`lettura ultimo giro ${r.status}`);
  const righe = await r.json();
  const fine = righe && righe[0] && righe[0].details && righe[0].details.a;
  if (!fine) return null;
  if (!Number.isFinite(Date.parse(fine))) throw new Error('ultimo giro con fine non valida');
  return new Date(Date.parse(fine)).toISOString();
}
export const CATEGORIE = ['pazienti', 'visite', 'referti_file', 'fattori_2fa'];

export async function eseguiRiconciliazione({ supabaseUrl, supabaseKey, runErrors = [], now = Date.now(), fetchImpl = fetch }) {
  const base = `${supabaseUrl}/rest/v1`;
  const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };
  const a = new Date(now - MARGINE).toISOString();
  let da = new Date(now - MARGINE - H24).toISOString();
  const esito = { da, a, mancanti: {} };
  try {
    const fine = await fineUltimoGiro({ base, headers, fetchImpl });
    const finestra = { ripresa: fine ? 'ultimo_giro' : 'prime_24h' };
    if (fine) da = fine;
    if (Date.parse(a) - Date.parse(da) > MAX_FINESTRA) {
      finestra.finestra_troncata = true; finestra.da_originale = da;
      da = new Date(Date.parse(a) - MAX_FINESTRA).toISOString();
      runErrors.push({ ramo: 'riconciliazione', ref: 'registro', msg: `ultimo giro riuscito oltre 30 giorni fa (${finestra.da_originale}): controllato solo da ${da}; il periodo precedente resta scoperto` });
    }
    esito.da = da; Object.assign(esito, finestra);
    if (Date.parse(da) >= Date.parse(a)) {
      for (const k of CATEGORIE) esito.mancanti[k] = 0;
      esito.totale = 0;
      await tracciaFallimento({ base, headers, action: 'riconciliazione_registro_eseguita', details: { fonte: 'cron', da, a, ...finestra, finestra_vuota: true, mancanti: esito.mancanti }, ramo: 'riconciliazione' });
      return esito;
    }
    const r = await fetchImpl(`${base}/rpc/riconcilia_registro`, {
      method: 'POST', headers, body: JSON.stringify({ p_da: da, p_a: a })
    });
    if (!r.ok) throw new Error(`riconcilia_registro ${r.status}`);
    const out = await r.json();
    let totale = 0;
    for (const k of CATEGORIE) {
      const ids = Array.isArray(out && out[k]) ? out[k] : [];
      esito.mancanti[k] = ids.length;
      totale += ids.length;
    }
    esito.totale = totale;
    if (totale > 0) {
      const ids = {};
      for (const k of CATEGORIE) if (Array.isArray(out[k]) && out[k].length) ids[k] = out[k].slice(0, 50).map(String);
      runErrors.push({ ramo: 'riconciliazione', ref: 'registro', msg: `${totale} operazion${totale === 1 ? 'e' : 'i'} senza traccia nel registro fra ${da} e ${a}: ${CATEGORIE.filter(k => esito.mancanti[k]).map(k => `${k} ${esito.mancanti[k]}`).join(', ')} (identificativi nella riga registro_discrepanza)` });
      await tracciaFallimento({ base, headers, action: 'registro_discrepanza', details: { fonte: 'cron', da, a, ...finestra, mancanti: esito.mancanti, ids }, ramo: 'riconciliazione' });
    } else {
      await tracciaFallimento({ base, headers, action: 'riconciliazione_registro_eseguita', details: { fonte: 'cron', da, a, ...finestra, mancanti: esito.mancanti }, ramo: 'riconciliazione' });
    }
  } catch (e) {
    esito.errore = e.message;
    runErrors.push({ ramo: 'riconciliazione', ref: 'registro', msg: e.message });
    await tracciaFallimento({ base, headers, action: 'riconciliazione_registro_fallita', details: { fonte: 'cron', da, a, errore: e.message }, ramo: 'riconciliazione' });
  }
  return esito;
}
