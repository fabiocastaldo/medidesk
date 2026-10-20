// Test con doppi del blocco di cancellazione (legal hold, s84 20/10/2026; piano riga 44): lib/blocco-guard.js e il suo
// uso in lib/elimina-account.js e lib/uscita.js. Esecuzione: node test/blocco-cancellazione.test.mjs — nessuna rete.
import assert from 'node:assert/strict';
import { bloccoAttivo, tracciaBloccoSeNuova } from '../lib/blocco-guard.js';
import { eseguiEliminazioniAccount } from '../lib/elimina-account.js';
import { eseguiUscita, GIORNI_PROVA } from '../lib/uscita.js';

const G = 86400000;
const shell = { esc: s => String(s), emailShell: b => b, emailTitle: t => t, ctaButton: (u, l) => l };
const blocco = { id: 7, dal: '2026-10-20T08:00:00Z', riesame_il: '2026-11-19', fino_al: '2027-01-18', autorizzato_da: 'gestore su istruzione scritta del Titolare' };

function doppio({ blocchi = {}, tracce = [], medici = [] }) {
  const scritte = [], cancellazioni = [];
  const fetchVera = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url); const metodo = (init && init.method) || 'GET';
    if (u.includes('/rest/v1/blocchi_cancellazione')) { const id = u.match(/medico_id=eq\.([\w-]+)/)[1]; return { ok: true, json: async () => blocchi[id] ? [blocchi[id]] : [] }; }
    if (u.includes('/rest/v1/audit_log') && metodo === 'GET') { const id = u.match(/medico_id=eq\.([\w-]+)/)[1]; return { ok: true, json: async () => [...tracce, ...scritte].filter(t => t.medico_id === id) }; }
    if (u.includes('/rest/v1/audit_log') && metodo === 'POST') { scritte.push(JSON.parse(init.body)); return { ok: true, status: 201 }; }
    if (u.includes('/rest/v1/medici') && metodo === 'GET' && !u.includes('id=eq.')) return { ok: true, json: async () => medici };
    if (metodo === 'DELETE') { cancellazioni.push(u); return { ok: true, status: 204 }; }
    if (u.includes('select=count') || u.includes('Prefer')) return { ok: true, json: async () => [], headers: new Map([['content-range', '0-0/0']]) };
    return { ok: true, status: 200, json: async () => [], text: async () => '' };
  };
  return { scritte, cancellazioni, ripristina: () => { globalThis.fetch = fetchVera; } };
}

// 1) bloccoAttivo: riga → oggetto; nessuna riga → null; lettura fallita → lancia (fail-closed).
{
  const d = doppio({ blocchi: { m1: blocco } });
  try {
    assert.deepEqual(await bloccoAttivo('https://d/rest/v1', {}, 'm1'), blocco); assert.equal(await bloccoAttivo('https://d/rest/v1', {}, 'm2'), null);
  } finally { d.ripristina(); }
  const fetchVera = globalThis.fetch; globalThis.fetch = async () => ({ ok: false, status: 500 });
  try { await assert.rejects(() => bloccoAttivo('https://d/rest/v1', {}, 'm1'), /blocchi_cancellazione 500/); } finally { globalThis.fetch = fetchVera; }
  console.log('ok 1: bloccoAttivo e fail-closed');
}
// 2) tracciaBloccoSeNuova: una volta per blocco e contesto.
{
  const d = doppio({});
  try {
    assert.equal(await tracciaBloccoSeNuova('https://d/rest/v1', {}, 'm1', blocco, 'uscita_cessazione'), true);
    assert.equal(await tracciaBloccoSeNuova('https://d/rest/v1', {}, 'm1', blocco, 'uscita_cessazione'), false);
    assert.equal(await tracciaBloccoSeNuova('https://d/rest/v1', {}, 'm1', blocco, 'eliminazione_richiesta'), true);
    assert.equal(d.scritte.length, 2); assert.equal(d.scritte[0].action, 'cancellazione_sospesa_blocco'); assert.equal(d.scritte[0].details.blocco_id, 7);
  } finally { d.ripristina(); }
  console.log('ok 2: traccia una volta per blocco e contesto');
}
// 3) Eliminazione su richiesta: il medico bloccato non viene cancellato (nessuna DELETE), conteggio bloccati, traccia; l'altro sì.
{
  const medici = [{ id: 'm1', user_id: 'u1', email: 'a@x.it', deleted_at: '2026-09-01T00:00:00Z' }, { id: 'm2', user_id: 'u2', email: 'b@x.it', deleted_at: '2026-09-01T00:00:00Z' }];
  const d = doppio({ blocchi: { m1: blocco }, medici });
  const runErrors = [];
  try {
    const esito = await eseguiEliminazioniAccount({ supabaseUrl: 'https://doppio.supabase.co', supabaseKey: 'k', stripeKey: null, resend: { emails: { send: async () => ({}) } }, shell, runErrors, now: Date.parse('2026-10-20T17:00:00Z') });
    assert.equal(esito.candidati, 2); assert.equal(esito.bloccati, 1);
    assert.ok(!d.cancellazioni.some(u => u.includes('u1') || u.includes('m1')), 'm1 non cancellato');
    assert.ok(d.scritte.some(t => t.action === 'cancellazione_sospesa_blocco' && t.medico_id === 'm1' && t.details.contesto === 'eliminazione_richiesta'));
  } finally { d.ripristina(); }
  console.log('ok 3: eliminazione su richiesta rispetta il blocco');
}
// 4) Uscita alla cessazione: medico free cessato e bloccato → niente avviso, niente cancellazione, bloccati 1, traccia.
{
  const creato = new Date(Date.parse('2026-10-20T00:00:00Z') - (GIORNI_PROVA + 40) * G).toISOString();
  const medici = [{ id: 'm1', user_id: 'u1', email: 'a@x.it', piano: 'free', created_at: creato, current_period_end: null }];
  const inviate = [];
  const d = doppio({ blocchi: { m1: blocco }, medici });
  const runErrors = [];
  try {
    const esito = await eseguiUscita({ supabaseUrl: 'https://doppio.supabase.co', supabaseKey: 'k', stripeKey: null, resend: { emails: { send: async p => { inviate.push(p); return {}; } } }, shell, runErrors, now: Date.parse('2026-10-20T17:00:00Z') });
    assert.equal(esito.cessati, 1); assert.equal(esito.bloccati, 1); assert.equal(esito.avvisi, 0); assert.equal(esito.cancellati, 0); assert.equal(inviate.length, 0);
    assert.ok(d.scritte.some(t => t.action === 'cancellazione_sospesa_blocco' && t.details.contesto === 'uscita_cessazione'));
    assert.equal(runErrors.length, 0);
  } finally { d.ripristina(); }
  console.log('ok 4: uscita alla cessazione rispetta il blocco');
}
console.log('blocco cancellazione: 4/4');
