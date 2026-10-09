// lib/backup-storage.js
// Backup distinto dello Storage dei referti (s77, 09/10/2026; piano privacy riga 33, A02 T08).
//
// Perché: il backup giornaliero di Supabase copre il database, non lo Storage. I referti stanno nel bucket
// privato `fotoreferti`, già cifrati nel browser del medico (chiave per medico in medici.referti_dek, avvolta da
// AWS KMS, quindi dentro il backup del database): la copia porta solo il ciphertext e non abbassa T07.
//
// Cosa fa: una volta al giorno, dentro il cron di api/send-reminders, elenca gli oggetti di `fotoreferti` dalla
// Storage API (service_role), elenca le chiavi già nel bucket S3 di backup (ListObjectsV2) e allinea i due insiemi:
// copia in S3 gli oggetti nuovi o cambiati (dimensione o ETag diversi), cancella da S3 le chiavi che nello Storage
// non esistono più (cancellazione del referto, del paziente o del medico). Nessuno stato proprio: la verità è il
// confronto fra i due elenchi a ogni giro.
//
// Dove: bucket BACKUP_STORAGE_BUCKET (eu-central-1, versioning acceso, versioni non correnti eliminate dopo 90
// giorni dalla regola del ciclo di vita, Block Public Access, SSE-S3, nessun Object Lock: la copia deve sparire
// alla cancellazione nell'ambiente attivo, entro i 90 giorni della Policy di conservazione). Stesse chiavi IAM
// del registro (REGISTRO_AWS_*), utente delphi-med-registro-writer con policy `backup-referti-storage`:
// s3:PutObject e s3:DeleteObject sul contenuto, s3:ListBucket sul bucket; nessuna lettura degli oggetti.
//
// Limiti per giro: MAX_COPIE_PER_GIRO oggetti e MAX_BYTE_PER_GIRO byte; il resto va al giro dopo e il totale
// rimasto compare nell'alert admin. Traccia in audit_log (backup_storage_eseguito / backup_storage_simulato)
// con i conteggi e le chiavi toccate. Firma SigV4 fatta qui, senza SDK, come per il registro.

import { createHash, createHmac } from 'crypto';

export const BUCKET_STORAGE = 'fotoreferti';
export const REGION = 'eu-central-1';
export const MAX_COPIE_PER_GIRO = 100;
export const MAX_BYTE_PER_GIRO = 50 * 1024 * 1024;
export const MAX_CANCELLAZIONI_PER_GIRO = 200;
const PAGINA_STORAGE = 1000;
const MAX_PROFONDITA = 8;

const hmac = (k, s) => createHmac('sha256', k).update(s).digest();
const sha256hex = (b) => createHash('sha256').update(b).digest('hex');
const encodeRfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Firma SigV4 generica verso S3 (virtual host): metodo, chiave (o '' per il bucket), query, corpo opzionale.
export function firmaS3({ metodo, bucket, chiave = '', query = {}, corpo = null, contentType, keyId, secret, region = REGION, dataMs = Date.now() }) {
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const path = '/' + chiave.split('/').map(encodeRfc3986).join('/');
  const amzDate = new Date(dataMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const data = amzDate.slice(0, 8);
  const payload = corpo == null ? Buffer.alloc(0) : (Buffer.isBuffer(corpo) ? corpo : Buffer.from(corpo, 'utf8'));
  const payloadHash = sha256hex(payload);
  const h = { 'host': host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (corpo != null) {
    h['content-md5'] = createHash('md5').update(payload).digest('base64');
    h['content-type'] = contentType || 'application/octet-stream';
  }
  const nomi = Object.keys(h).sort();
  const qs = Object.keys(query).sort().map(k => `${encodeRfc3986(k)}=${encodeRfc3986(String(query[k]))}`).join('&');
  const canon = [metodo, path, qs, nomi.map(n => `${n}:${h[n]}\n`).join(''), nomi.join(';'), payloadHash].join('\n');
  const scope = `${data}/${region}/s3/aws4_request`;
  const daFirmare = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canon)].join('\n');
  const kFirma = hmac(hmac(hmac(hmac('AWS4' + secret, data), region), 's3'), 'aws4_request');
  const firma = createHmac('sha256', kFirma).update(daFirmare, 'utf8').digest('hex');
  const headers = { ...h, 'authorization': `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${nomi.join(';')}, Signature=${firma}` };
  delete headers.host;
  return { url: `https://${host}${path}${qs ? '?' + qs : ''}`, headers, payload };
}

const xmlDecode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Elenco delle chiavi nel bucket S3 di backup: Map chiave -> { byte, etag }.
export async function elencoS3({ bucket, prefisso, keyId, secret }) {
  const out = new Map();
  let token = null;
  for (let p = 0; p < 100; p++) {
    const query = { 'list-type': '2', 'prefix': prefisso, 'max-keys': '1000' };
    if (token) query['continuation-token'] = token;
    const { url, headers } = firmaS3({ metodo: 'GET', bucket, query, keyId, secret });
    const r = await fetch(url, { headers });
    const testo = await r.text();
    if (!r.ok) throw new Error(`S3 list ${r.status} ${testo.slice(0, 160)}`);
    for (const m of testo.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const k = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]); const s = /<Size>(\d+)<\/Size>/.exec(m[1]); const e = /<ETag>([\s\S]*?)<\/ETag>/.exec(m[1]);
      if (k) out.set(xmlDecode(k[1]), { byte: s ? Number(s[1]) : -1, etag: e ? xmlDecode(e[1]).replace(/"/g, '') : '' });
    }
    const t = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(testo);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(testo) || !t) return out;
    token = xmlDecode(t[1]);
  }
  throw new Error('S3 list: troppe pagine');
}

// Elenco ricorsivo degli oggetti dello Storage: Map percorso -> { byte, etag, updated_at }.
export async function elencoStorage({ supabaseUrl, supabaseKey, bucket = BUCKET_STORAGE }) {
  const out = new Map();
  const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };
  async function visita(prefisso, livello) {
    if (livello > MAX_PROFONDITA) throw new Error(`Storage: profondità oltre ${MAX_PROFONDITA} in ${prefisso}`);
    for (let offset = 0; ; offset += PAGINA_STORAGE) {
      const r = await fetch(`${supabaseUrl}/storage/v1/object/list/${bucket}`, {
        method: 'POST', headers,
        body: JSON.stringify({ prefix: prefisso, limit: PAGINA_STORAGE, offset, sortBy: { column: 'name', order: 'asc' } })
      });
      if (!r.ok) throw new Error(`Storage list ${r.status}`);
      const voci = await r.json();
      if (!Array.isArray(voci)) throw new Error('Storage list non valida');
      for (const v of voci) {
        const percorso = prefisso ? `${prefisso}/${v.name}` : v.name;
        if (v.id == null) { await visita(percorso, livello + 1); continue; }   // cartella
        const meta = v.metadata || {};
        out.set(percorso, { byte: Number(meta.size ?? -1), etag: String(meta.eTag || '').replace(/"/g, ''), updated_at: v.updated_at || null });
      }
      if (voci.length < PAGINA_STORAGE) break;
    }
  }
  await visita('', 0);
  return out;
}

// Piano di allineamento, puro: cosa copiare e cosa cancellare.
export function pianoAllineamento(storage, s3, prefisso) {
  const copie = [], cancellazioni = [];
  for (const [p, o] of storage) {
    const k = `${prefisso}/${p}`;
    const s = s3.get(k);
    const md5 = /^[0-9a-f]{32}$/i;   // l'ETag vale come impronta solo se è un MD5 semplice da entrambe le parti
    const diverso = !s || s.byte !== o.byte || (md5.test(o.etag) && md5.test(s.etag) && o.etag.toLowerCase() !== s.etag.toLowerCase());
    if (diverso) copie.push({ percorso: p, chiave: k, byte: o.byte });
  }
  for (const k of s3.keys()) {
    if (!k.startsWith(`${prefisso}/`)) continue;
    if (!storage.has(k.slice(prefisso.length + 1))) cancellazioni.push(k);
  }
  copie.sort((a, b) => a.percorso < b.percorso ? -1 : 1);
  cancellazioni.sort();
  return { copie, cancellazioni };
}

async function scaricaStorage({ supabaseUrl, supabaseKey, bucket, percorso }) {
  const url = `${supabaseUrl}/storage/v1/object/${bucket}/${percorso.split('/').map(encodeURIComponent).join('/')}`;
  const r = await fetch(url, { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } });
  if (!r.ok) throw new Error(`Storage get ${r.status} ${percorso}`);
  return { corpo: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || 'application/octet-stream' };
}

async function mettiS3({ bucket, chiave, corpo, contentType, keyId, secret }) {
  const { url, headers, payload } = firmaS3({ metodo: 'PUT', bucket, chiave, corpo, contentType, keyId, secret });
  const r = await fetch(url, { method: 'PUT', headers, body: payload });
  if (!r.ok) throw new Error(`S3 put ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`);
  return sha256hex(payload);
}

async function togliS3({ bucket, chiave, keyId, secret }) {
  const { url, headers } = firmaS3({ metodo: 'DELETE', bucket, chiave, keyId, secret });
  const r = await fetch(url, { method: 'DELETE', headers });
  if (!r.ok && r.status !== 404) throw new Error(`S3 delete ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`);
}

export async function eseguiBackupStorage({ supabaseUrl, supabaseKey, runErrors = [], now = Date.now(), dryRun = false,
  scarica = scaricaStorage, metti = mettiS3, togli = togliS3, elencaS3 = elencoS3, elencaStorage = elencoStorage }) {
  const esito = { bucket: BUCKET_STORAGE, oggetti: 0, in_s3: 0, copiati: 0, cancellati: 0, byte_copiati: 0, rimasti: 0, errori: 0, chiavi: [] };
  const bucketS3 = process.env.BACKUP_STORAGE_BUCKET;
  const keyId = process.env.REGISTRO_AWS_ACCESS_KEY_ID;
  const secret = process.env.REGISTRO_AWS_SECRET_ACCESS_KEY;
  try {
    if (!bucketS3 || !keyId || !secret) throw new Error('variabili BACKUP_STORAGE_BUCKET / REGISTRO_AWS_* mancanti');
    const [storage, s3] = await Promise.all([
      elencaStorage({ supabaseUrl, supabaseKey }),
      elencaS3({ bucket: bucketS3, prefisso: `${BUCKET_STORAGE}/`, keyId, secret })
    ]);
    esito.oggetti = storage.size; esito.in_s3 = s3.size;
    const { copie, cancellazioni } = pianoAllineamento(storage, s3, BUCKET_STORAGE);
    let byte = 0, n = 0;
    for (const c of copie) {
      if (n >= MAX_COPIE_PER_GIRO || byte + Math.max(c.byte, 0) > MAX_BYTE_PER_GIRO) { esito.rimasti++; continue; }
      n++; byte += Math.max(c.byte, 0);
      if (dryRun) { esito.copiati++; esito.byte_copiati += Math.max(c.byte, 0); esito.chiavi.push({ op: 'put', chiave: c.chiave, byte: c.byte }); continue; }
      try {
        const { corpo, contentType } = await scarica({ supabaseUrl, supabaseKey, bucket: BUCKET_STORAGE, percorso: c.percorso });
        const sha256 = await metti({ bucket: bucketS3, chiave: c.chiave, corpo, contentType, keyId, secret });
        esito.copiati++; esito.byte_copiati += corpo.length;
        if (esito.chiavi.length < 50) esito.chiavi.push({ op: 'put', chiave: c.chiave, byte: corpo.length, sha256 });
      } catch (e) {
        esito.errori++; runErrors.push({ ramo: 'backup_storage', ref: c.chiave, msg: e.message });
      }
    }
    for (const k of cancellazioni.slice(0, MAX_CANCELLAZIONI_PER_GIRO)) {
      if (dryRun) { esito.cancellati++; esito.chiavi.push({ op: 'delete', chiave: k }); continue; }
      try {
        await togli({ bucket: bucketS3, chiave: k, keyId, secret });
        esito.cancellati++;
        if (esito.chiavi.length < 50) esito.chiavi.push({ op: 'delete', chiave: k });
      } catch (e) {
        esito.errori++; runErrors.push({ ramo: 'backup_storage', ref: k, msg: e.message });
      }
    }
    esito.rimasti += Math.max(cancellazioni.length - MAX_CANCELLAZIONI_PER_GIRO, 0);
    if (esito.rimasti > 0) runErrors.push({ ramo: 'backup_storage', ref: 'rimasti', msg: `${esito.rimasti} oggetti oltre il limite del giro: ripresi domani` });
    // Traccia: sempre, anche a zero (prova che il giro è avvenuto e del confronto fatto).
    const base = `${supabaseUrl}/rest/v1`;
    const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' };
    const a = await fetch(`${base}/audit_log`, {
      method: 'POST', headers,
      body: JSON.stringify({ action: dryRun ? 'backup_storage_simulato' : 'backup_storage_eseguito', target_type: 'sistema', details: { ...esito, bucket_s3: bucketS3, generato_at: new Date(now).toISOString() } })
    });
    if (!a.ok) throw new Error(`traccia ${a.status}`);
  } catch (e) {
    esito.errore = e.message;
    runErrors.push({ ramo: 'backup_storage', ref: 'backup_storage', msg: e.message });
    console.error('[backup-storage]', e.message);
  }
  console.log('[backup-storage]', JSON.stringify({ ...esito, chiavi: esito.chiavi.length }));
  return esito;
}
