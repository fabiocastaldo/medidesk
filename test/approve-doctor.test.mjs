// Test con doppi di api/approve-doctor.js — guardia del mailer (F-06a-bis) e impronta dei dati verificati (B-08), s96, 25/10/2026.
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

async function chiama(req, { ses, medico = MEDICO, patchVuota = false }) {
  if (ses) { process.env.SES_AWS_ACCESS_KEY_ID = 'AKIA_DOPPIO'; process.env.SES_AWS_SECRET_ACCESS_KEY = 'segreto-ses'; process.env.SES_REGION = 'eu-central-1'; }
  else { delete process.env.SES_AWS_ACCESS_KEY_ID; delete process.env.SES_AWS_SECRET_ACCESS_KEY; }
  const chiamate = [], mail = [], audit = [], patch = [];
  const fetchVera = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); chiamate.push((init.method || 'GET') + ' ' + u);
    if (u.includes('amazonaws.com')) { mail.push(u); return { ok: true, status: 200, text: async () => '{"MessageId":"x"}', json: async () => ({ MessageId: 'x' }) }; }
    if (u.includes('/approve_tokens') && !init.method) return { ok: true, json: async () => [{ used_at: null }] };
    if (u.includes('/medici') && !init.method) return { ok: true, json: async () => [medico] };
    if (u.includes('/audit_log')) { audit.push(JSON.parse(init.body)); return { ok: true, status: 201 }; }
    if (init.method === 'PATCH') { patch.push(u); return { ok: true, json: async () => (patchVuota && u.includes('/medici') ? [] : [{ id: 'x' }]) }; }
    throw new Error('chiamata inattesa: ' + u);
  };
  const res = { code: 0, body: '', setHeader() {}, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; } };
  try { await handler(req, res); } finally { globalThis.fetch = fetchVera; }
  return { res, chiamate, mail, audit, patch };
}

// 1) Senza credenziali SES: 500 prima di ogni lettura o scrittura (fallimento chiuso), sia in GET sia in POST.
for (const req of [{ method: 'GET', query: { token: TOKEN } },
                   { method: 'POST', body: { token: TOKEN, esito: 'trovato', numero_esito: 'coincide', pec: 'ada@pec.it' } }]) {
  const r = await chiama(req, { ses: false });
  assert.equal(r.res.code, 500); assert.match(r.res.body, /Configurazione server incompleta/);
  assert.equal(r.chiamate.length, 0, 'nessuna chiamata senza mailer: ' + r.chiamate.join(', '));
}

// 2) GET con SES: solo la pagina di verifica con l'impronta, nessuna scrittura, nessuna mail.
const impDi = (html) => (html.match(/name="impronta" value="([^"]+)"/) || [])[1];
let IMP;
{
  const r = await chiama({ method: 'GET', query: { token: TOKEN } }, { ses: true });
  IMP = impDi(r.res.body); assert.ok(IMP && IMP.length > 20, 'impronta nel form');
  assert.equal(r.res.code, 200); assert.match(r.res.body, /Verifica e approvazione del medico/);
  assert.equal(r.mail.length, 0); assert.equal(r.audit.length, 0);
}

// 3) POST positivo con PEC: avviso alla PEC e benvenuto passano da SES, traccia avviso_pec «inviato», pagina lo dice.
{
  const r = await chiama({ method: 'POST', body: { token: TOKEN, impronta: IMP, esito: 'trovato', numero_esito: 'coincide', pec: 'ada@pec.it' } }, { ses: true });
  assert.equal(r.res.code, 200); assert.match(r.res.body, /Avviso inviato alla PEC indicata/);
  assert.equal(r.mail.length, 2, 'PEC + benvenuto');
  assert.deepEqual(r.audit.map(a => a.action), ['verifica_qualifica', 'medico_approvato']);
  assert.equal(r.audit[1].details.avviso_pec, 'inviato');
  assert.equal(r.audit[0].details.impronta_dati, IMP);
  // B-08: prima la PATCH di stato con i quattro campi verificati, poi il consumo del link
  assert.equal(r.patch.length, 2); assert.match(r.patch[0], /\/medici\?id=eq\.m1&stato=eq\.in_attesa&nome=eq\.Ada&cognome=eq\.Prova&numero_iscrizione_ordine=eq\.123&provincia_ordine=eq\.Pavia/);
  assert.match(r.patch[1], /\/approve_tokens\?/);
}

// 4) POST negativo: mail di esito al medico via SES, traccia «inviata».
{
  const r = await chiama({ method: 'POST', body: { token: TOKEN, impronta: IMP, esito: 'non_trovato', numero_esito: 'coincide' } }, { ses: true });
  assert.equal(r.res.code, 200); assert.match(r.res.body, /inviata la mail di esito negativo/);
  assert.equal(r.mail.length, 1);
  assert.deepEqual(r.audit.map(a => a.action), ['verifica_qualifica_negativa', 'esito_negativo_comunicato']);
  assert.equal(r.audit[1].details.mail, 'inviata');
}

// 5) B-08: il medico cambia il cognome dopo l'apertura della pagina → 409, pagina coi dati nuovi e impronta nuova, nessuna scrittura né mail.
{
  const cambiato = { ...MEDICO, cognome: 'Altro' };
  const r = await chiama({ method: 'POST', body: { token: TOKEN, impronta: IMP, esito: 'trovato', numero_esito: 'coincide', pec: 'ada@pec.it' } }, { ses: true, medico: cambiato });
  assert.equal(r.res.code, 409); assert.match(r.res.body, /sono cambiati dopo l&#39;apertura|sono cambiati dopo l'apertura/); assert.match(r.res.body, /Altro/);
  assert.notEqual(impDi(r.res.body), IMP);
  assert.equal(r.audit.length, 0); assert.equal(r.patch.length, 0); assert.equal(r.mail.length, 0);
}

// 6) B-08: impronta assente (pagina aperta prima del rilascio) → 409 senza scritture; vale anche per l'esito negativo.
{
  const r = await chiama({ method: 'POST', body: { token: TOKEN, esito: 'non_trovato', numero_esito: 'coincide' } }, { ses: true });
  assert.equal(r.res.code, 409); assert.equal(r.audit.length, 0); assert.equal(r.patch.length, 0); assert.equal(r.mail.length, 0);
}

// 7) B-08: dati cambiati fra rilettura e scrittura (PATCH a 0 righe) → 409, link NON consumato, nessuna mail.
{
  const r = await chiama({ method: 'POST', body: { token: TOKEN, impronta: IMP, esito: 'trovato', numero_esito: 'coincide', pec: 'ada@pec.it' } }, { ses: true, patchVuota: true });
  assert.equal(r.res.code, 409); assert.match(r.res.body, /Il link resta valido/);
  assert.equal(r.patch.length, 1); assert.match(r.patch[0], /\/medici\?/);
  assert.equal(r.mail.length, 0); assert.deepEqual(r.audit.map(a => a.action), ['verifica_qualifica']);
}
console.log('approve-doctor: 7 casi OK');
