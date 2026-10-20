// Test con doppi di lib/testi-vigenti.js e lib/avvisi-testi.js (s84, 20/10/2026; piano righe 22 e 76).
// Esecuzione: node test/testi-vigenti.test.mjs — nessuna rete: fetch e mailer sono doppi in memoria.
import assert from 'node:assert/strict';
import { statoAccettazioni, faseAvviso, avvisiAttivi, TESTI_VIGENTI, PREAVVISO_GIORNI, PROMEMORIA_GIORNI } from '../lib/testi-vigenti.js';
import { eseguiAvvisiTesti, MAX_EMAIL_PER_GIRO } from '../lib/avvisi-testi.js';

const G = 86400000;
const H = '0'.repeat(64);
const h = c => c.repeat(64);
const shell = { esc: s => String(s), emailShell: b => b, emailTitle: t => `<h1>${t}</h1>`, ctaButton: (u, l) => `<a href="${u}">${l}</a>` };

// 1) Configurazione in vigore oggi: niente sostanziale → nessuna richiesta a chiunque, anche con hash vecchi.
{
  const r = statoAccettazioni([{ documento: 'tos', hash_testo: h('3') }, { documento: 'dpa', hash_testo: h('0') }]);
  assert.deepEqual(r, { da_accettare: [], bloccante: false, prossima_decorrenza: null });
  assert.equal(TESTI_VIGENTI.tos.sostanziale, false); assert.equal(TESTI_VIGENTI.dpa.sostanziale, false);
  console.log('ok 1: oggi nessuna riaccettazione richiesta');
}
// 2) Versione sostanziale pubblicata con decorrenza futura: avviso, non bloccante; chi l'ha accettata non la vede.
const testi = {
  tos: { nome: 'Termini', pagina: '/termini-di-servizio', versione: 'tos-2.3', hash: h('a'), decorrenza: '2026-12-01T00:00:00Z', sostanziale: true },
  dpa: { nome: 'DPA', pagina: '/dpa', versione: 'dpa-2.3', hash: h('b'), decorrenza: '2026-12-01T00:00:00Z', sostanziale: true }
};
const prima = Date.parse('2026-11-01T10:00:00Z'), dopo = Date.parse('2026-12-01T00:00:01Z');
{
  const r = statoAccettazioni([{ documento: 'tos', hash_testo: h('3') }, { documento: 'dpa', hash_testo: h('0') }], prima, testi);
  assert.equal(r.da_accettare.length, 2); assert.equal(r.bloccante, false); assert.equal(r.prossima_decorrenza, '2026-12-01T00:00:00Z');
  assert.equal(r.da_accettare[0].bloccante, false);
  const g = statoAccettazioni([{ documento: 'tos', hash_testo: h('a') }, { documento: 'dpa', hash_testo: h('b') }], dopo, testi);
  assert.deepEqual(g.da_accettare, []); assert.equal(g.bloccante, false);
  const parz = statoAccettazioni([{ documento: 'tos', hash_testo: h('a') }, { documento: 'dpa', hash_testo: h('0') }], dopo, testi);
  assert.equal(parz.da_accettare.length, 1); assert.equal(parz.da_accettare[0].documento, 'dpa'); assert.equal(parz.bloccante, true);
  console.log('ok 2: avviso prima della decorrenza, blocco dopo, solo per chi non ha accettato');
}
// 3) Fasi dell'avviso.
{
  assert.equal(faseAvviso('2026-12-01T00:00:00Z', prima), 'avviso');
  assert.equal(faseAvviso('2026-12-01T00:00:00Z', Date.parse('2026-12-01T00:00:00Z') - PROMEMORIA_GIORNI * G + 1000), 'promemoria');
  assert.equal(faseAvviso('2026-12-01T00:00:00Z', dopo), 'scaduto');
  assert.equal(faseAvviso(null, prima), null);
  assert.ok(PREAVVISO_GIORNI >= 30, 'Termini art. 11: almeno 30 giorni');
  console.log('ok 3: fasi avviso / promemoria / scaduto');
}
// 4) Avvisi di servizio attivi per finestra.
{
  const av = [{ id: 'man-1', titolo: 'M', testo: 't', dal: '2026-11-01T00:00:00Z', al: '2026-11-03T00:00:00Z' }];
  assert.equal(avvisiAttivi(prima, av).length, 1); assert.equal(avvisiAttivi(dopo, av).length, 0);
  console.log('ok 4: avvisi di servizio per finestra');
}
// Doppio del cron: 3 medici (uno senza email), tracce e accettazioni in memoria.
async function giro({ now, tracce = [], accettazioni = {}, avvisi = [], testiCfg = testi, mailOk = true, medici, decorrenzeDb }) {
  const inviate = [], scritte = [], runErrors = [];
  const lista = medici || [
    { id: 'm1', email: 'a@x.it', titolo: 'Dott.', nome: 'A', cognome: 'A' },
    { id: 'm2', email: 'b@x.it', nome: 'B', cognome: 'B' },
    { id: 'm3', email: null, nome: 'C', cognome: 'C' }
  ];
  const fetchVera = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/rest/v1/testi_decorrenze')) {
      if (decorrenzeDb === 'giu') return { ok: false, status: 500 };
      const rows = decorrenzeDb || Object.entries(testiCfg).map(([documento, t]) => ({ documento, hash_testo: t.hash, sostanziale: t.sostanziale, decorrenza: t.decorrenza, created_at: '2026-10-20T00:00:00Z' }));
      return { ok: true, json: async () => rows };
    }
    if (u.includes('/rest/v1/medici')) return { ok: true, json: async () => lista };
    if (u.includes('/rest/v1/accettazioni_legali')) { const id = u.match(/medico_id=eq\.(\w+)/)[1]; return { ok: true, json: async () => accettazioni[id] || [] }; }
    if (u.includes('/rest/v1/audit_log') && (!init || !init.method)) { const id = u.match(/medico_id=eq\.(\w+)/)[1]; return { ok: true, json: async () => [...tracce.filter(t => t.medico_id === id), ...scritte.filter(t => t.medico_id === id)] }; }
    if (u.includes('/rest/v1/audit_log') && init.method === 'POST') { scritte.push(JSON.parse(init.body)); return { ok: true, status: 201 }; }
    throw new Error('url non attesa ' + u);
  };
  const resend = { emails: { send: async p => { if (!mailOk) return { error: { message: 'smtp giù' } }; inviate.push(p); return { data: { id: 'msg' + inviate.length } }; } } };
  try {
    const esito = await eseguiAvvisiTesti({ supabaseUrl: 'https://doppio.supabase.co', supabaseKey: 'k', resend, shell, runErrors, now, testi: testiCfg, avvisi });
    return { esito, inviate, scritte, runErrors };
  } finally { globalThis.fetch = fetchVera; }
}
// 5) Configurazione di oggi: il cron non legge nemmeno i medici.
{
  const r = await giro({ now: prima, testiCfg: TESTI_VIGENTI });
  assert.equal(r.esito.medici, 0); assert.equal(r.inviate.length, 0); assert.equal(r.esito.coerenza_db, 'ok'); assert.equal(r.runErrors.length, 0);
  console.log('ok 5: senza sostanziali il ramo non legge i medici; specchio DB coerente');
}
// 6) Prima decorrenza: un avviso per medico con email (2), due tracce ciascuno (tos+dpa), destinatario pseudonimo; secondo giro: zero.
{
  const r = await giro({ now: prima });
  assert.equal(r.esito.medici, 3); assert.equal(r.esito.avvisi_testi, 2); assert.equal(r.inviate.length, 2);
  assert.match(r.inviate[0].subject, /nuove condizioni del servizio dal 01\/12\/2026/);
  assert.equal(r.scritte.length, 4); assert.equal(r.scritte[0].action, 'avviso_testi_legali'); assert.equal(r.scritte[0].details.fase, 'avviso');
  assert.notEqual(r.scritte[0].details.to, 'a@x.it'); assert.equal(r.scritte[0].details.chiave, `tos:${h('a').slice(0, 16)}:avviso`);
  const r2 = await giro({ now: prima + G, tracce: r.scritte });
  assert.equal(r2.inviate.length, 0); assert.equal(r2.esito.avvisi_testi, 0);
  console.log('ok 6: un avviso per medico e impronta, mai ripetuto');
}
// 7) Promemoria a 7 giorni solo a chi non ha ancora accettato; chi ha accettato nel frattempo non riceve nulla; dopo la decorrenza nessuna email.
{
  const avvisoFatto = (await giro({ now: prima })).scritte;
  const prom = Date.parse('2026-12-01T00:00:00Z') - 3 * G;
  const r = await giro({ now: prom, tracce: avvisoFatto, accettazioni: { m1: [{ documento: 'tos', hash_testo: h('a') }, { documento: 'dpa', hash_testo: h('b') }] } });
  assert.equal(r.inviate.length, 1); assert.equal(r.inviate[0].to[0], 'b@x.it'); assert.match(r.inviate[0].subject, /promemoria/);
  assert.equal(r.esito.promemoria_testi, 1); assert.equal(r.scritte.filter(x => x.details.fase === 'promemoria').length, 2);
  const r3 = await giro({ now: dopo, tracce: [...avvisoFatto, ...r.scritte] });
  assert.equal(r3.inviate.length, 0);
  console.log('ok 7: promemoria solo ai ritardatari, silenzio dopo la decorrenza');
}
// 8) Avviso di servizio: una email per medico e per id, anche senza testi sostanziali; errore mail → runErrors, nessuna traccia.
{
  const av = [{ id: 'man-1', titolo: 'Manutenzione', testo: 'Domenica 06:00–07:00 UTC', dal: '2026-11-01T00:00:00Z', al: '2026-11-03T00:00:00Z' }];
  const r = await giro({ now: prima, testiCfg: TESTI_VIGENTI, avvisi: av });
  assert.equal(r.esito.avvisi_servizio, 2); assert.equal(r.scritte.length, 2); assert.equal(r.scritte[0].action, 'avviso_servizio'); assert.equal(r.scritte[0].details.chiave, 'man-1');
  const r2 = await giro({ now: prima + G, testiCfg: TESTI_VIGENTI, avvisi: av, tracce: r.scritte });
  assert.equal(r2.inviate.length, 0);
  const ko = await giro({ now: prima, testiCfg: TESTI_VIGENTI, avvisi: av, mailOk: false });
  assert.equal(ko.esito.errori, 2); assert.equal(ko.scritte.length, 0); assert.equal(ko.runErrors.length, 2);
  console.log('ok 8: avvisi di servizio una volta per id; mail fallita → alert senza traccia');
}
// 9) Limite per giro: 60 medici → 50 email, rimasti 10, alert.
{
  const medici = Array.from({ length: 60 }, (_, i) => ({ id: 'x' + i, email: `m${i}@x.it`, nome: 'N', cognome: 'C' }));
  const r = await giro({ now: prima, medici });
  assert.equal(r.inviate.length, MAX_EMAIL_PER_GIRO); assert.equal(r.esito.rimasti, 10); assert.ok(r.runErrors.some(e => e.ref === 'rimasti'));
  console.log('ok 9: tetto per giro e ripresa');
}
// 10) Specchio DB divergente (hash diverso per dpa, decorrenza diversa per tos) → alert; DB giù → non_verificata con alert, il ramo prosegue.
{
  const rows = [
    { documento: 'tos', hash_testo: h('a'), sostanziale: true, decorrenza: '2026-12-15T00:00:00Z', created_at: '2026-10-20T00:00:00Z' },
    { documento: 'dpa', hash_testo: h('c'), sostanziale: true, decorrenza: '2026-12-01T00:00:00Z', created_at: '2026-10-20T00:00:00Z' },
    { documento: 'dpa', hash_testo: h('b'), sostanziale: true, decorrenza: '2026-12-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z' }
  ];
  const r = await giro({ now: prima, decorrenzeDb: rows });
  assert.equal(r.esito.coerenza_db, 'divergente'); assert.ok(r.runErrors.some(e => e.ref === 'testi_decorrenze' && /tos, dpa/.test(e.msg)));
  assert.equal(r.inviate.length, 2, 'gli avvisi partono comunque');
  const g = await giro({ now: prima, decorrenzeDb: 'giu' });
  assert.equal(g.esito.coerenza_db, 'non_verificata'); assert.ok(g.runErrors.some(e => e.ref === 'testi_decorrenze')); assert.equal(g.inviate.length, 2);
  console.log('ok 10: coerenza lib ↔ testi_decorrenze: divergente e non verificata danno alert');
}
console.log('testi vigenti + avvisi: 10/10');
