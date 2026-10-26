// Test con doppi di api/medico.js — origine fidata della shell (C-07) ed errori non in cache (D-07), s96, 26/10/2026.
// Esecuzione: node test/medico.test.mjs — nessuna rete: RPC, centri e shell sono doppi di fetch.
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://doppio.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'anon-doppia';
const { default: handler } = await import('../api/medico.js');

const SHELL = '<!DOCTYPE html><html><head><title>Delphi~Med</title></head><body>app</body></html>';
const MEDICO = { id: 'm1', nome: 'Ada', cognome: 'Prova', titolo: 'Dott.ssa', slug: 'ada-prova', specializzazione: 'Cardiologia' };

async function chiama({ env = {}, rpc = { ok: true, body: [MEDICO] }, shell = { ok: true }, host = 'evil.example' } = {}) {
  const salva = { VERCEL_ENV: process.env.VERCEL_ENV, VERCEL_URL: process.env.VERCEL_URL };
  delete process.env.VERCEL_ENV; delete process.env.VERCEL_URL; Object.assign(process.env, env);
  const chiamate = [];
  const fetchVera = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); chiamate.push(u);
    if (u.includes('/rpc/get_medico_pubblico')) {
      if (rpc.lancia) throw new Error('rete');
      return { ok: rpc.ok, status: rpc.ok ? 200 : 500, json: async () => rpc.body };
    }
    if (u.includes('/rest/v1/centri')) return { ok: true, json: async () => [] };
    if (u.endsWith('/medidesk.html')) return { ok: shell.ok, status: shell.ok ? 200 : 500, text: async () => (shell.ok ? SHELL : 'errore interno') };
    throw new Error('chiamata inattesa: ' + u);
  };
  const h = {};
  const res = { code: 0, body: '', setHeader(k, v) { h[k.toLowerCase()] = v; }, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; } };
  try { await handler({ query: { slug: 'ada-prova' }, headers: { host } }, res); }
  finally { globalThis.fetch = fetchVera; for (const k of Object.keys(salva)) { if (salva[k] === undefined) delete process.env[k]; else process.env[k] = salva[k]; } }
  return { res, h, chiamate };
}

// 1) Host ostile ignorato: in produzione (e senza variabili di sistema) la shell arriva dal dominio canonico.
for (const env of [{ VERCEL_ENV: 'production', VERCEL_URL: 'medidesk-abc.vercel.app' }, {}]) {
  const r = await chiama({ env });
  assert.equal(r.res.code, 200); assert.match(r.res.body, /<title>Dott\.ssa Ada Prova/);
  assert.ok(r.chiamate.includes('https://www.delphi-med.com/medidesk.html'), r.chiamate.join(' '));
  assert.ok(!r.chiamate.some(u => u.includes('evil.example')), 'mai l\'Host della richiesta');
  assert.equal(r.h['cache-control'], 's-maxage=60');
}

// 2) In anteprima la shell arriva dal deploy stesso.
{
  const r = await chiama({ env: { VERCEL_ENV: 'preview', VERCEL_URL: 'medidesk-xyz.vercel.app' } });
  assert.ok(r.chiamate.includes('https://medidesk-xyz.vercel.app/medidesk.html'));
}

// 3) RPC in errore (500 o eccezione): 503 senza cache, mai la 404 in CDN.
for (const rpc of [{ ok: false, body: {} }, { lancia: true }]) {
  const r = await chiama({ rpc });
  assert.equal(r.res.code, 503); assert.equal(r.h['cache-control'], 'no-store'); assert.equal(r.h['retry-after'], '30');
  assert.ok(!r.chiamate.some(u => u.endsWith('/medidesk.html')), 'niente shell se la RPC fallisce');
}

// 4) Slug inesistente (array vuoto): resta la 404 piccola e cacheabile.
{
  const r = await chiama({ rpc: { ok: true, body: [] } });
  assert.equal(r.res.code, 404); assert.match(r.h['cache-control'], /s-maxage=300/);
}

// 5) Shell in errore: 503 senza cache, mai il corpo dell'errore servito come pagina.
{
  const r = await chiama({ shell: { ok: false } });
  assert.equal(r.res.code, 503); assert.equal(r.h['cache-control'], 'no-store'); assert.doesNotMatch(r.res.body, /errore interno/);
}
console.log('medico: 5 gruppi di casi OK');
