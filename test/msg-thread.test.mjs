// Test con doppi di api/msg-thread.js, azione «apri» — destinatario e data di nascita (C-03a, D-02), s96, 26/10/2026.
// Esecuzione: node test/msg-thread.test.mjs — nessuna rete: GoTrue, PostgREST e SES sono doppi di fetch.
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://doppio.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'srv'; process.env.SUPABASE_PUBLISHABLE_KEY = 'anon';
process.env.SES_AWS_ACCESS_KEY_ID = 'AKIA_DOPPIO'; process.env.SES_AWS_SECRET_ACCESS_KEY = 'segreto'; process.env.SES_REGION = 'eu-central-1';
delete process.env.MFA_OBBLIGATORIA_MEDICO;
const { default: handler } = await import('../api/msg-thread.js');

const MEDICO = { id: 'med1', titolo: 'Dott.', nome: 'Ippo', cognome: 'Crate', msg_durata_giorni: 30, msg_tempi_risposta: null };
const FASC = { id: 'paz1', email: 'paziente@esempio.it', telefono: null, data_nascita: '1950-03-04', limitato_at: null };
// prenotazione per conto: il recapito dell'appuntamento e' quello di chi ha prenotato
const APPT = { id: 'app1', paziente_id: 'paz1', email_paziente: 'figlia@esempio.it', telefono_paziente: '333' };

async function apri(body, { fascicolo = FASC, appt = APPT } = {}) {
  const mail = [], thread = [];
  const fetchVera = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('amazonaws.com')) { mail.push(String(init.body || '')); return { ok: true, status: 200, text: async () => '{"MessageId":"m"}', json: async () => ({ MessageId: 'm' }) }; }
    if (u.includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'u1', factors: [] }) };
    if (u.includes('/rest/v1/medici?')) return { ok: true, json: async () => [MEDICO] };
    if (u.includes('/rpc/medico_puo_scrivere')) return { ok: true, json: async () => true };
    if (u.includes('/rest/v1/appuntamenti?')) return { ok: true, json: async () => (appt ? [appt] : []) };
    if (u.includes('/rest/v1/pazienti?')) return { ok: true, json: async () => (fascicolo ? [fascicolo] : []) };
    if (u.endsWith('/rest/v1/thread_messaggi') && init.method === 'POST') { const b = JSON.parse(init.body); thread.push(b); return { ok: true, json: async () => [{ id: 't1', ...b }] }; }
    if (u.endsWith('/rest/v1/token_thread') || u.endsWith('/rest/v1/messaggi') || u.endsWith('/rest/v1/audit_log')) return { ok: true, status: 201, json: async () => [] };
    throw new Error('chiamata inattesa: ' + (init.method || 'GET') + ' ' + u);
  };
  const res = { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  try { await handler({ method: 'POST', headers: { authorization: 'Bearer jwt.finto.x' }, body: { action: 'apri', ...body } }, res); }
  finally { globalThis.fetch = fetchVera; }
  return { res, mail, thread };
}

// 1) Dal fascicolo: canale aperto verso l'email del fascicolo.
{
  const r = await apri({ paziente_id: 'paz1' });
  assert.equal(r.res.code, 200, JSON.stringify(r.res.body)); assert.equal(r.thread[0].recapito_email, 'paziente@esempio.it');
  assert.equal(r.mail.length, 1); assert.match(r.mail[0], /paziente%40esempio\.it|paziente@esempio\.it/);
}

// 2) C-03a: da una prenotazione per conto il recapito e' quello del fascicolo, mai quello di chi ha prenotato.
{
  const r = await apri({ appuntamento_id: 'app1' });
  assert.equal(r.res.code, 200); assert.equal(r.thread[0].recapito_email, 'paziente@esempio.it'); assert.equal(r.thread[0].recapito_tel, null);
  assert.doesNotMatch(r.mail.join(' '), /figlia/);
}

// 3) Prenotazione non collegata a un fascicolo → 409 fascicolo_richiesto, nessun thread, nessuna mail.
{
  const r = await apri({ appuntamento_id: 'app1' }, { appt: { ...APPT, paziente_id: null } });
  assert.equal(r.res.code, 409); assert.equal(r.res.body.error, 'fascicolo_richiesto'); assert.equal(r.thread.length, 0); assert.equal(r.mail.length, 0);
}

// 4) D-02: fascicolo senza data di nascita → 409 nascita_mancante, nessun thread, nessuna mail.
{
  const r = await apri({ paziente_id: 'paz1' }, { fascicolo: { ...FASC, data_nascita: null } });
  assert.equal(r.res.code, 409); assert.equal(r.res.body.error, 'nascita_mancante'); assert.equal(r.thread.length, 0); assert.equal(r.mail.length, 0);
}

// 5) Fascicolo senza email → 409 email_mancante (invariato).
{
  const r = await apri({ paziente_id: 'paz1' }, { fascicolo: { ...FASC, email: null } });
  assert.equal(r.res.code, 409); assert.equal(r.res.body.error, 'email_mancante');
}
console.log('msg-thread: 5 casi OK');
