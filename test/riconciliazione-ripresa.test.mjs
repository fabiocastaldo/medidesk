// Test con doppi della ripresa della riconciliazione del registro (B-09, s96, 25/10/2026).
// Esecuzione: node test/riconciliazione-ripresa.test.mjs — nessuna rete: audit_log e RPC sono doppi di fetch.
import assert from 'node:assert/strict';
import { eseguiRiconciliazione } from '../lib/riconciliazione-registro.js';

const NOW = Date.parse('2026-10-26T17:00:00Z');
const A = '2026-10-26T16:50:00.000Z';

async function giro({ ultimo, letturaOk = true, rpcOut = { pazienti: [], visite: [], referti_file: [], fattori_2fa: [] } }) {
  const rpc = [], tracce = [], runErrors = [];
  const fetchVera = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/audit_log?action=in.(')) {
      assert.match(u, /riconciliazione_registro_eseguita,registro_discrepanza/); assert.match(u, /order=created_at\.desc&limit=1/);
      if (!letturaOk) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, json: async () => (ultimo ? [{ details: ultimo }] : []) };
    }
    if (u.includes('/rpc/riconcilia_registro')) { rpc.push(JSON.parse(init.body)); return { ok: true, json: async () => rpcOut }; }
    if (u.endsWith('/audit_log') && init.method === 'POST') { tracce.push(JSON.parse(init.body)); return { ok: true, status: 201 }; }
    throw new Error('chiamata inattesa: ' + u);
  };
  try {
    const esito = await eseguiRiconciliazione({ supabaseUrl: 'https://doppio.supabase.co', supabaseKey: 'k', runErrors, now: NOW });
    return { esito, rpc, tracce, runErrors };
  } finally { globalThis.fetch = fetchVera; }
}

// 1) Il cron e' saltato due sere: si riparte dalla fine dell'ultimo giro riuscito, tre giorni prima.
{
  const r = await giro({ ultimo: { a: '2026-10-23T16:50:50.069Z' } });
  assert.deepEqual(r.rpc, [{ p_da: '2026-10-23T16:50:50.069Z', p_a: A }]);
  assert.equal(r.tracce.length, 1); assert.equal(r.tracce[0].action, 'riconciliazione_registro_eseguita');
  assert.equal(r.tracce[0].details.ripresa, 'ultimo_giro'); assert.equal(r.tracce[0].details.da, '2026-10-23T16:50:50.069Z');
  assert.equal(r.runErrors.length, 0);
}

// 2) Nessun giro precedente: le 24 ore.
{
  const r = await giro({ ultimo: null });
  assert.deepEqual(r.rpc, [{ p_da: '2026-10-25T16:50:00.000Z', p_a: A }]);
  assert.equal(r.tracce[0].details.ripresa, 'prime_24h');
}

// 3) Lettura dell'ultimo giro fallita: fallimento chiuso, nessuna RPC, traccia «fallita», avviso.
{
  const r = await giro({ ultimo: null, letturaOk: false });
  assert.equal(r.rpc.length, 0);
  assert.equal(r.tracce.length, 1); assert.equal(r.tracce[0].action, 'riconciliazione_registro_fallita');
  assert.match(r.tracce[0].details.errore, /lettura ultimo giro 503/); assert.equal(r.runErrors.length, 1);
}

// 4) Ultimo giro oltre 30 giorni fa: finestra troncata a 30 giorni, buco dichiarato e avviso.
{
  const r = await giro({ ultimo: { a: '2026-09-01T16:50:00.000Z' } });
  assert.deepEqual(r.rpc, [{ p_da: '2026-09-26T16:50:00.000Z', p_a: A }]);
  assert.equal(r.tracce[0].details.finestra_troncata, true); assert.equal(r.tracce[0].details.da_originale, '2026-09-01T16:50:00.000Z');
  assert.equal(r.runErrors.length, 1); assert.match(r.runErrors[0].msg, /oltre 30 giorni/);
}

// 5) L'ultimo giro riuscito e' una discrepanza: vale come giro esaminato; mancanze nuove → registro_discrepanza con la ripresa.
{
  const r = await giro({ ultimo: { a: '2026-10-25T16:50:13.516Z' }, rpcOut: { pazienti: ['p1'], visite: [], referti_file: [], fattori_2fa: [] } });
  assert.deepEqual(r.rpc, [{ p_da: '2026-10-25T16:50:13.516Z', p_a: A }]);
  assert.equal(r.tracce[0].action, 'registro_discrepanza'); assert.equal(r.tracce[0].details.ripresa, 'ultimo_giro');
  assert.deepEqual(r.tracce[0].details.ids, { pazienti: ['p1'] }); assert.equal(r.runErrors.length, 1);
}

// 6) Due giri ravvicinati (fine dell'ultimo giro >= a): nessuna RPC, traccia eseguita con finestra vuota.
{
  const r = await giro({ ultimo: { a: '2026-10-26T16:55:00.000Z' } });
  assert.equal(r.rpc.length, 0); assert.equal(r.tracce[0].action, 'riconciliazione_registro_eseguita');
  assert.equal(r.tracce[0].details.finestra_vuota, true);
}
console.log('riconciliazione-ripresa: 6 casi OK');
