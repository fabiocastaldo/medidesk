// Test con doppi della guardia proporzionale di lib/backup-storage.js (s78, 10/10/2026).
// Esecuzione: node test/backup-storage-guardia.test.mjs — nessuna rete: fetch è sostituita da un doppio che
// registra la traccia in audit_log; Storage, S3, PUT e DELETE sono doppi in memoria.
import assert from 'node:assert/strict';
import { eseguiBackupStorage, guardiaCancellazioni, SOGLIA_GUARDIA_MIN, BUCKET_STORAGE } from '../lib/backup-storage.js';

process.env.BACKUP_STORAGE_BUCKET = 'bucket-doppio';
process.env.REGISTRO_AWS_ACCESS_KEY_ID = 'AKIA_DOPPIO';
process.env.REGISTRO_AWS_SECRET_ACCESS_KEY = 'segreto-doppio';

const obj = (i) => ({ byte: 100 + i, etag: ('0'.repeat(32) + i.toString(16)).slice(-32) });
function scenario({ inStorage, inS3 }) {
  // inStorage: n oggetti nello Storage (o1..on); inS3: n chiavi in S3 (fotoreferti/o1..on) con byte/etag identici.
  const storage = new Map(); const s3 = new Map();
  for (let i = 1; i <= inStorage; i++) storage.set(`o${i}`, obj(i));
  for (let i = 1; i <= inS3; i++) s3.set(`${BUCKET_STORAGE}/o${i}`, obj(i));
  return { storage, s3 };
}
async function giro({ inStorage, inS3 }) {
  const { storage, s3 } = scenario({ inStorage, inS3 });
  const tolte = [], messe = [], tracce = [], runErrors = [];
  const fetchVera = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).endsWith('/rest/v1/audit_log'), 'solo la traccia passa da fetch: ' + url);
    tracce.push(JSON.parse(init.body)); return { ok: true, status: 201 };
  };
  try {
    const esito = await eseguiBackupStorage({
      supabaseUrl: 'https://doppio.supabase.co', supabaseKey: 'chiave-doppia', runErrors, now: Date.parse('2026-10-10T17:00:00Z'),
      elencaStorage: async () => storage, elencaS3: async () => s3,
      scarica: async ({ percorso }) => ({ corpo: Buffer.alloc(storage.get(percorso).byte), contentType: 'application/pdf' }),
      metti: async ({ chiave }) => { messe.push(chiave); return 'sha-doppio'; },
      togli: async ({ chiave }) => { tolte.push(chiave); }
    });
    return { esito, tolte, messe, tracce, runErrors };
  } finally { globalThis.fetch = fetchVera; }
}

// Funzione pura.
assert.equal(guardiaCancellazioni({ oggetti: 6, inS3: 9, daCancellare: 3 }), null);
assert.equal(guardiaCancellazioni({ oggetti: 9, inS3: 20, daCancellare: 11 }), 'oltre_meta');
assert.equal(guardiaCancellazioni({ oggetti: 10, inS3: 20, daCancellare: 10 }), null, 'la metà esatta non scatta');
assert.equal(guardiaCancellazioni({ oggetti: 0, inS3: 1, daCancellare: 1 }), 'storage_vuoto');
assert.equal(guardiaCancellazioni({ oggetti: 0, inS3: 0, daCancellare: 0 }), null);
assert.equal(guardiaCancellazioni({ oggetti: 1, inS3: 9, daCancellare: 8 }), null, `sotto ${SOGLIA_GUARDIA_MIN} la (b) non scatta`);

// 1) 6 nello Storage, 9 in S3 → 3 cancellazioni: passa (in_s3 < soglia).
{
  const r = await giro({ inStorage: 6, inS3: 9 });
  assert.deepEqual(r.tolte, ['fotoreferti/o7', 'fotoreferti/o8', 'fotoreferti/o9']);
  assert.equal(r.esito.cancellati, 3); assert.equal(r.esito.copiati, 0); assert.equal(r.esito.sospeso, undefined);
  assert.equal(r.tracce.length, 1); assert.equal(r.tracce[0].action, 'backup_storage_eseguito'); assert.equal(r.runErrors.length, 0);
  console.log('ok 1: 6/3 passa (3 DELETE, traccia eseguito)');
}
// 2) 9 nello Storage, 20 in S3 → 11 cancellazioni > 10: sospeso, nessun DELETE, copie zero, traccia sospeso, alert.
{
  const r = await giro({ inStorage: 9, inS3: 20 });
  assert.deepEqual(r.tolte, []); assert.equal(r.esito.cancellati, 0); assert.equal(r.esito.rimasti, 0);
  assert.deepEqual(r.esito.sospeso, { motivo: 'oltre_meta', da_cancellare: 11 });
  assert.equal(r.tracce[0].action, 'backup_storage_sospeso'); assert.deepEqual(r.tracce[0].details.sospeso, { motivo: 'oltre_meta', da_cancellare: 11 });
  assert.equal(r.runErrors.length, 1); assert.equal(r.runErrors[0].ref, 'cancellazioni_sospese'); assert.match(r.runErrors[0].msg, /11 cancellazioni su 20 .*oltre_meta/);
  console.log('ok 2: 20/11 sospeso (0 DELETE, traccia sospeso, alert admin)');
}
// 3) Storage vuoto, 1 in S3: sospeso (storage_vuoto), nessun DELETE.
{
  const r = await giro({ inStorage: 0, inS3: 1 });
  assert.deepEqual(r.tolte, []); assert.deepEqual(r.esito.sospeso, { motivo: 'storage_vuoto', da_cancellare: 1 });
  assert.equal(r.tracce[0].action, 'backup_storage_sospeso'); assert.equal(r.runErrors.length, 1); assert.match(r.runErrors[0].msg, /storage_vuoto/);
  console.log('ok 3: 0 Storage con 1 in S3 sospeso');
}
// 4) Le copie proseguono anche a guardia scattata: 12 nuovi nello Storage (o21..o32) e 20 in S3 di cui 11 spariti.
{
  const { storage, s3 } = scenario({ inStorage: 9, inS3: 20 });
  for (let i = 21; i <= 32; i++) storage.set(`o${i}`, obj(i));
  const tolte = [], messe = [], tracce = [], runErrors = [];
  const fetchVera = globalThis.fetch; globalThis.fetch = async (u, init) => { tracce.push(JSON.parse(init.body)); return { ok: true }; };
  try {
    const esito = await eseguiBackupStorage({ supabaseUrl: 'https://doppio.supabase.co', supabaseKey: 'k', runErrors,
      elencaStorage: async () => storage, elencaS3: async () => s3,
      scarica: async ({ percorso }) => ({ corpo: Buffer.alloc(storage.get(percorso).byte), contentType: 'application/pdf' }),
      metti: async ({ chiave }) => { messe.push(chiave); return 'sha'; }, togli: async ({ chiave }) => { tolte.push(chiave); } });
    assert.equal(messe.length, 12); assert.equal(esito.copiati, 12); assert.deepEqual(tolte, []); assert.equal(esito.sospeso.motivo, 'oltre_meta');
    assert.equal(tracce[0].action, 'backup_storage_sospeso'); assert.equal(tracce[0].details.copiati, 12);
  } finally { globalThis.fetch = fetchVera; }
  console.log('ok 4: copie 12/12 anche a guardia scattata');
}
// 5) Metà esatta con S3 a 20: passa (10 DELETE).
{
  const r = await giro({ inStorage: 10, inS3: 20 });
  assert.equal(r.tolte.length, 10); assert.equal(r.esito.sospeso, undefined); assert.equal(r.tracce[0].action, 'backup_storage_eseguito');
  console.log('ok 5: 20/10 passa');
}
console.log('guardia: 5/5 scenari + funzione pura');
