// lib/riconciliazione-registro.js — B-09 (riesame grey box, s93, decisione del gestore).
// Le tracce automatiche del registro delle operazioni (audit_fascicolo, audit_referti_file, audit_mfa_fattori,
// audit_password) restano non bloccanti: se la scrittura della traccia fallisce l'operazione clinica prosegue.
// Ogni sera questo ramo del cron confronta, per le 24 ore precedenti, pazienti, visite, file dei referti e
// dispositivi della verifica in due passaggi creati con le rispettive tracce (RPC riconcilia_registro, solo
// service_role). Una traccia mancante diventa un avviso all'amministratore e una riga registro_discrepanza con i
// soli identificativi; un errore del ramo diventa riconciliazione_registro_fallita. Il cambio di password non e'
// riconciliabile (nessun dato oltre la traccia stessa): limite dichiarato in A02.
import { tracciaFallimento } from './registro-amministratori.js';

const H24 = 24 * 60 * 60 * 1000;
const MARGINE = 10 * 60 * 1000; // le scritture degli ultimi 10 minuti passano al giro successivo
export const CATEGORIE = ['pazienti', 'visite', 'referti_file', 'fattori_2fa'];

export async function eseguiRiconciliazione({ supabaseUrl, supabaseKey, runErrors = [], now = Date.now(), fetchImpl = fetch }) {
  const base = `${supabaseUrl}/rest/v1`;
  const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };
  const a = new Date(now - MARGINE).toISOString();
  const da = new Date(now - MARGINE - H24).toISOString();
  const esito = { da, a, mancanti: {} };
  try {
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
      await tracciaFallimento({ base, headers, action: 'registro_discrepanza', details: { fonte: 'cron', da, a, mancanti: esito.mancanti, ids }, ramo: 'riconciliazione' });
    } else {
      await tracciaFallimento({ base, headers, action: 'riconciliazione_registro_eseguita', details: { fonte: 'cron', da, a, mancanti: esito.mancanti }, ramo: 'riconciliazione' });
    }
  } catch (e) {
    esito.errore = e.message;
    runErrors.push({ ramo: 'riconciliazione', ref: 'registro', msg: e.message });
    await tracciaFallimento({ base, headers, action: 'riconciliazione_registro_fallita', details: { fonte: 'cron', da, a, errore: e.message }, ramo: 'riconciliazione' });
  }
  return esito;
}
