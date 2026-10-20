// Test con doppi della traccia di fallimento di lib/registro-amministratori.js (s84, 20/10/2026).
// Esecuzione: node test/registro-fallimento.test.mjs — nessuna rete: fetch, lettura log e scrittura S3 sono doppi.
import assert from 'node:assert/strict';
import { eseguiRegistro, tracciaFallimento } from '../lib/registro-amministratori.js';

process.env.REGISTRO_SUPABASE_LOG_TOKEN = 'token-doppio';
process.env.REGISTRO_AWS_ACCESS_KEY_ID = 'AKIA_DOPPIO';
process.env.REGISTRO_AWS_SECRET_ACCESS_KEY = 'segreto-doppio';
const NOW = Date.parse('2026-10-18T17:00:00Z'); // il giro dell'incidente

async function giro({ fatti, scrivi, leggi, tracciaOk = true }) {
  const tracce = [], runErrors = [];
  const fetchVera = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    assert.ok(u.includes('/rest/v1/audit_log'), 'solo audit_log passa da fetch: ' + u);
    if (!init || !init.method) return { ok: true, json: async () => fatti.map(g => ({ details: { giorno: g } })) };
    tracce.push(JSON.parse(init.body)); return { ok: tracciaOk, status: tracciaOk ? 201 : 500 };
  };
  try {
    const esito = await eseguiRegistro({ supabaseUrl: 'https://doppio.supabase.co', supabaseKey: 'k', runErrors, now: NOW, scrivi, leggi });
    return { esito, tracce, runErrors };
  } finally { globalThis.fetch = fetchVera; }
}

// 1) Giro sano: il 17/10 manca, si esporta, una traccia esportato, zero errori.
{
  const r = await giro({ fatti: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'],
    leggi: async () => [{ a: 1 }, { a: 2 }], scrivi: async () => {} });
  assert.deepEqual(r.esito.giorni, [{ giorno: '2026-10-17', righe: 2 }]); assert.equal(r.esito.errore, undefined);
  assert.equal(r.tracce.length, 1); assert.equal(r.tracce[0].action, 'registro_amministratori_esportato'); assert.equal(r.runErrors.length, 0);
  console.log('ok 1: giro sano, traccia esportato');
}
// 2) La PUT su S3 fallisce come il 18/10: nessuna traccia esportato, una traccia fallito con errore e giorni fatti vuoti, alert.
{
  const r = await giro({ fatti: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'],
    leggi: async () => [], scrivi: async () => { throw new Error('S3 403 <Code>SignatureDoesNotMatch</Code>'); } });
  assert.match(r.esito.errore, /SignatureDoesNotMatch/); assert.equal(r.esito.traccia_fallimento, true);
  assert.equal(r.tracce.length, 1); assert.equal(r.tracce[0].action, 'registro_amministratori_fallito'); assert.equal(r.tracce[0].target_type, 'sistema');
  assert.match(r.tracce[0].details.errore, /SignatureDoesNotMatch/); assert.deepEqual(r.tracce[0].details.giorni_fatti, []);
  assert.equal(r.tracce[0].details.generato_at, '2026-10-18T17:00:00.000Z');
  assert.equal(r.runErrors.length, 1); assert.equal(r.runErrors[0].ramo, 'registro');
  console.log('ok 2: PUT fallita → traccia registro_amministratori_fallito');
}
// 3) Fallimento al secondo giorno: il primo è tracciato esportato, il fallito porta giorni_fatti con quello.
{
  let n = 0;
  const r = await giro({ fatti: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'],
    leggi: async () => [{ a: 1 }], scrivi: async () => { if (++n === 2) throw new Error('S3 500'); } });
  assert.equal(r.tracce.length, 2); assert.equal(r.tracce[0].action, 'registro_amministratori_esportato'); assert.equal(r.tracce[0].details.giorno, '2026-10-16');
  assert.equal(r.tracce[1].action, 'registro_amministratori_fallito'); assert.deepEqual(r.tracce[1].details.giorni_fatti, [{ giorno: '2026-10-16', righe: 1 }]);
  console.log('ok 3: fallimento al secondo giorno, giorni_fatti conservati');
}
// 4) Variabili mancanti: fallito scritto anche prima di ogni rete; se PostgREST respinge, false senza lancio.
{
  const salvato = process.env.REGISTRO_AWS_SECRET_ACCESS_KEY; delete process.env.REGISTRO_AWS_SECRET_ACCESS_KEY;
  try {
    const r = await giro({ fatti: [], leggi: async () => [], scrivi: async () => {}, tracciaOk: false });
    assert.match(r.esito.errore, /REGISTRO_\* mancanti/); assert.equal(r.esito.traccia_fallimento, false); assert.equal(r.tracce[0].action, 'registro_amministratori_fallito');
  } finally { process.env.REGISTRO_AWS_SECRET_ACCESS_KEY = salvato; }
  console.log('ok 4: variabili mancanti → fallito; traccia respinta → false');
}
// 5) Funzione di traccia: fetch che lancia → false, nessuna eccezione.
{
  const fetchVera = globalThis.fetch; globalThis.fetch = async () => { throw new Error('rete giù'); };
  try { assert.equal(await tracciaFallimento({ base: 'x', headers: {}, action: 'a', details: {}, ramo: 'test' }), false); }
  finally { globalThis.fetch = fetchVera; }
  console.log('ok 5: tracciaFallimento non lancia');
}
console.log('registro fallimento: 5/5');
