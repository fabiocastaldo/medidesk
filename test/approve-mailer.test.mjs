// Test con doppi di api/approve-doctor.js — guardia del mailer (F-06a-bis, s96, 25/10/2026).
// Esecuzione: node test/approve-mailer.test.mjs — nessuna rete: Supabase e SES sono doppi di fetch.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SUPABASE_URL = 'https://doppio.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'chiave-doppia';
process.env.APPROVE_TOKEN_SECRET = 'segreto-doppio';
process.env.CASELLA_GESTORE = 'gestore@esempio.it';
delete process.env.RESEND_API_KEY;
const { default: handler } = await import('../api/approve-doctor.js');

const b64u = (x) => Buffer.from(x).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const p = b64u(JSON.stringify({ user_id: 'u1', jti: 'j1', exp: Math.floor(Date.now() / 1000) + 3600 }));
const TOKEN = `${h}.${p}.` + b64u(crypto.createHmac('sha256', 'segreto-doppio').update(`${h}.${p}`).digest());
const MEDICO = { id: 'm1', email: 'medico@esempio.it', nome: 'Ada', cognome: 'Prova', numero_iscrizione_ordine: '123',
  provincia_ordine: 'Pavia', specializzazione: 'Cardiologia', created_at: '2026-10-25T08:00:00Z', stato: 'in_attesa' };

async function chiama(req, { ses }) {
  if (ses) { process.env.SES_AWS_ACCESS_KEY_ID = 'AKIA_DOPPIO'; process.env.SES_AWS_SECRET_ACCESS_KEY = 'segreto-ses'; process.env.SES_REGION = 'eu-central-1'; }
  else { delete process.env.SES_AWS_ACCESS_KEY_ID; delete process.env.SES_AWS_SECRET_ACCESS_KEY; }
  const chiamate = [], mail = [], audit = [];
  const fetchVera = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); chiamate.push((init.method || 'GET') + ' ' + u);
    if (u.includes('amazonaws.com')) { mail.push(u); return { ok: true, status: 200, text: async () => '{"MessageId":"x"}', json: async () => ({ MessageId: 'x' }) }; }
    if (u.includes('/approve_tokens') && !init.method) return { ok: true, json: async () => [{ used_at: null }] };
    if (u.includes('/medici') && !init.method) return { ok: true, json: async () => [MEDICO] };
    if (u.includes('/audit_log')) { audit.push(JSON.parse(init.body)); return { ok: true, status: 201 }; }
    if (init.method === 'PATCH') return { ok: true, json: async () => [{ id: 'x' }] };
    throw new Error('chiamata inattesa: ' + u);
  };
  const res = { code: 0, body: '', setHeader() {}, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; } };
  try { await handler(req, res); } finally { globalThis.fetch = fetchVera; }
  return { res, chiamate, mail, audit };
}

// 1) Senza credenziali SES: 500 prima di ogni lettura o scrittura (fallimento chiuso), sia in GET sia in POST.
for (const req of [{ method: 'GET', query: { token: TOKEN } },
                   { method: 'POST', body: { token: TOKEN, esito: 'trovato', numero_esito: 'coincide', pec: 'ada@pec.it' } }]) {
  const r = await chiama(req, { ses: false });
  assert.equal(r.res.code, 500); assert.match(r.res.body, /Configurazione server incompleta/);
  assert.equal(r.chiamate.length, 0, 'nessuna chiamata senza mailer: ' + r.chiamate.join(', '));
}

// 2) GET con SES: solo la pagina di verifica, nessuna scrittura, nessuna mail.
{
  const r = await chiama({ method: 'GET', query: { token: TOKEN } }, { ses: true });
  assert.equal(r.res.code, 200); assert.match(r.res.body, /Verifica e approvazione del medico/);
  assert.equal(r.mail.length, 0); assert.equal(r.audit.length, 0);
}

// 3) POST positivo con PEC: avviso alla PEC e benvenuto passano da SES, traccia avviso_pec «inviato», pagina lo dice.
{
  const r = await chiama({ method: 'POST', body: { token: TOKEN, esito: 'trovato', numero_esito: 'coincide', pec: 'ada@pec.it' } }, { ses: true });
  assert.equal(r.res.code, 200); assert.match(r.res.body, /Avviso inviato alla PEC indicata/);
  assert.equal(r.mail.length, 2, 'PEC + benvenuto');
  assert.deepEqual(r.audit.map(a => a.action), ['verifica_qualifica', 'medico_approvato']);
  assert.equal(r.audit[1].details.avviso_pec, 'inviato');
}

// 4) POST negativo: mail di esito al medico via SES, traccia «inviata».
{
  const r = await chiama({ method: 'POST', body: { token: TOKEN, esito: 'non_trovato', numero_esito: 'coincide' } }, { ses: true });
  assert.equal(r.res.code, 200); assert.match(r.res.body, /inviata la mail di esito negativo/);
  assert.equal(r.mail.length, 1);
  assert.deepEqual(r.audit.map(a => a.action), ['verifica_qualifica_negativa', 'esito_negativo_comunicato']);
  assert.equal(r.audit[1].details.mail, 'inviata');
}
console.log('approve-mailer: 4 casi OK');
