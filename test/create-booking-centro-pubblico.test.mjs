// Test con doppi di api/create-booking.js — regola «centro prenotabile dal pubblico» (D-01, s96, 26/10/2026).
// Esecuzione: node test/create-booking-centro-pubblico.test.mjs — nessuna rete, nessuna scrittura.
import assert from 'node:assert/strict';
import { creaSfida } from '../lib/verifica-email.js';

process.env.SUPABASE_URL = 'https://doppio.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'srv'; process.env.SUPABASE_PUBLISHABLE_KEY = 'anon';
process.env.CONSENSO_TOKEN_SECRET = 'segreto-consenso';
process.env.SES_AWS_ACCESS_KEY_ID = 'AKIA_DOPPIO'; process.env.SES_AWS_SECRET_ACCESS_KEY = 'segreto';
const { default: handler } = await import('../api/create-booking.js');

const MED = '11111111-1111-4111-8111-111111111111', CEN = '22222222-2222-4222-8222-222222222222';
const { sfida, codice } = creaSfida('segreto-consenso', 'ada@esempio.it');
const BODY = { medico_id: MED, centro_id: CEN, nome: 'Ada', cognome: 'Prova', data_nascita: '1980-01-01', email: 'ada@esempio.it', tel: '3331234567',
  tipo: 'Visita', data: '2030-01-07', ora: '09:00', sfida, codice };

let n = 0;
async function prenota(prenotabile) {
  const chiamate = [];
  const fetchVera = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); chiamate.push((init.method || 'GET') + ' ' + u);
    if (u.includes('/rpc/check_rate_limit')) return { ok: true, json: async () => true };
    if (u.includes('/rest/v1/centri?id=eq.')) return { ok: true, json: async () => [{ id: CEN }] };
    if (u.includes('/rpc/centro_prenotabile_pubblico')) {
      assert.deepEqual(JSON.parse(init.body), { p_centro_id: CEN });
      if (prenotabile === 'errore') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => prenotabile };
    }
    // oltre la regola: il test si ferma qui (risposta d'errore controllata), nessuna scrittura reale
    return { ok: false, status: 599, json: async () => ({}), text: async () => '' };
  };
  const res = { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  try { await handler({ method: 'POST', headers: { 'x-forwarded-for': '10.0.0.' + (++n) }, socket: {}, body: { ...BODY } }, res); }
  finally { globalThis.fetch = fetchVera; }
  const dopo = chiamate.slice(chiamate.findIndex(c => c.includes('centro_prenotabile_pubblico')) + 1);
  return { res, chiamate, dopo };
}

// 1) Centro non prenotabile dal pubblico (organizzazione con prenotazione pubblica spenta, centro offline o sospeso) → 403, nient'altro.
{
  const r = await prenota(false);
  assert.equal(r.res.code, 403); assert.match(r.res.body.error, /non accetta prenotazioni online/);
  assert.equal(r.dopo.length, 0, 'nessuna chiamata dopo la regola: ' + r.dopo.join(', '));
  assert.ok(!r.chiamate.some(c => c.startsWith('POST') && c.includes('/rest/v1/appuntamenti')));
}

// 2) Regola non verificabile → 502, nessuna prosecuzione (fallimento chiuso).
{
  const r = await prenota('errore');
  assert.equal(r.res.code, 502); assert.equal(r.dopo.length, 0);
}

// 3) Centro prenotabile → la richiesta prosegue oltre la regola.
{
  const r = await prenota(true);
  assert.notEqual(r.res.code, 403); assert.ok(r.dopo.length > 0, 'la richiesta deve proseguire');
}
console.log('create-booking (centro pubblico): 3 casi OK');
