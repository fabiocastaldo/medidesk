// lib/registro-amministratori.js
// Registro degli accessi degli amministratori (s60, 28/09/2026; piano privacy riga 43, A04 rev2.2:
// «log degli accessi logici completi, verificabili e protetti da alterazione, conservati per un periodo
// congruo non inferiore a sei mesi»).
//
// Da dove vengono le righe: pgaudit è attivo sul solo ruolo postgres (pgaudit.log = read, write, ddl, role),
// cioè il ruolo dell'SQL editor della dashboard e della Management API; log_statement = ddl registra in più
// le DDL di ogni ruolo. L'app lavora con service_role e non produce righe. Supabase (piano Pro) conserva
// questi log 7 giorni.
//
// Cosa fa: una volta al giorno, dentro il cron di api/send-reminders, legge dall'endpoint dei log della
// Management API (token REGISTRO_SUPABASE_LOG_TOKEN, solo permesso Logs: Read) le righe AUDIT e statement
// di un giorno UTC completo e le scrive in un file JSON Lines nel bucket S3 delphi-med-registro-amministratori
// (eu-central-1, Object Lock in Conformità 365 giorni, scadenza automatica a 366 giorni) con l'utente IAM
// delphi-med-registro-writer, che può solo aggiungere file (s3:PutObject). Nessuno, amministratore compreso,
// può modificare o cancellare un file prima di un anno.
//
// Quali giorni: i giorni completi da REGISTRO_DAL a ieri, negli ultimi GIORNI_RECUPERO; un giorno è fatto se
// audit_log ha una riga registro_amministratori_esportato con details.giorno uguale. Si esportano al più
// MAX_GIORNI_PER_GIRO giorni per giro, dal più vecchio: un giro mancato si recupera il giorno dopo, finché il
// log di Supabase (7 giorni) lo contiene. Un giorno ancora mancante al margine va nell'alert admin.
// Anche un giorno senza righe produce un file (prova di continuità). La traccia in audit_log porta giorno,
// chiave, numero di righe e SHA-256 del file: il confronto con il file nel bucket prova l'integrità.
// Avviso nell'alert admin da 14 giorni prima della scadenza del token dei log.
// La richiesta a S3 è firmata qui (AWS Signature V4) senza l'SDK, per non toccare le dipendenze condivise
// con KMS (chiave dei referti); Content-MD5 è obbligatorio sui bucket con Object Lock.

import { createHash, createHmac } from 'crypto';

export const REGISTRO_DAL = '2026-09-28';          // attivazione di pgaudit (28/09/2026 15:54 UTC)
export const TOKEN_SCADENZA = '2027-09-27';        // scadenza del token registro-log-lettura
export const BUCKET = 'delphi-med-registro-amministratori';
export const GIORNI_RECUPERO = 6;                  // log Supabase 7 giorni: 6 giorni completi recuperabili
export const MAX_GIORNI_PER_GIRO = 3;
const PAGINA = 1000;
const MAX_PAGINE = 50;
const H24 = 86400000;
const PROGETTO = 'ijdvozurgrsqunxgwdil';
const giorno = (ms) => new Date(ms).toISOString().slice(0, 10);

export function giorniDaEsportare(now, fatti) {
  const oggi = Date.parse(giorno(now) + 'T00:00:00Z');
  const out = [];
  for (let k = GIORNI_RECUPERO; k >= 1; k--) {
    const g = giorno(oggi - k * H24);
    if (g >= REGISTRO_DAL && !fatti.has(g)) out.push(g);
  }
  return out;
}

export function sqlGiorno(offset) {
  return "select id, timestamp, event_message, log_attributes['parsed.user_name'] as utente, "
    + "log_attributes['parsed.application_name'] as applicazione, log_attributes['parsed.connection_from'] as origine, "
    + "log_attributes['parsed.command_tag'] as comando from logs where source = 'postgres_logs' "
    + "and (event_message like 'AUDIT:%' or event_message like 'statement:%') "
    + `order by timestamp, id limit ${PAGINA} offset ${offset}`;
}

export async function leggiGiorno(g, token) {
  const start = `${g}T00:00:00Z`;
  const end = new Date(Date.parse(start) + H24).toISOString().replace('.000Z', 'Z');
  const righe = [];
  for (let p = 0; p < MAX_PAGINE; p++) {
    const q = new URLSearchParams({ sql: sqlGiorno(p * PAGINA), iso_timestamp_start: start, iso_timestamp_end: end });
    const r = await fetch(`https://api.supabase.com/v1/projects/${PROGETTO}/analytics/endpoints/logs?${q}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!r.ok) throw new Error(`lettura log ${r.status}`);
    const d = await r.json();
    if (d && d.error) throw new Error(`lettura log: ${String(d.error).slice(0, 120)}`);
    if (!d || !Array.isArray(d.result)) throw new Error('lettura log non valida');
    righe.push(...d.result);
    if (d.result.length < PAGINA) return righe;
  }
  throw new Error(`oltre ${MAX_PAGINE * PAGINA} righe in un giorno`);
}

export function componiFile(g, righe, generatoAt) {
  const testa = JSON.stringify({ registro: 'accessi amministratori Delphi~Med', giorno: g, fonte: 'postgres_logs (pgaudit, log_statement=ddl)', progetto: PROGETTO, righe: righe.length, generato_at: generatoAt });
  const corpo = [testa, ...righe.map(x => JSON.stringify(x))].join('\n') + '\n';
  return { corpo, sha256: createHash('sha256').update(corpo, 'utf8').digest('hex') };
}

const hmac = (k, s) => createHmac('sha256', k).update(s, 'utf8').digest();
const hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// Firma SigV4 di una PUT verso S3 (path-style virtual host). Restituisce URL e intestazioni.
export function firmaPut({ bucket, chiave, corpo, keyId, secret, region = 'eu-central-1', dataMs = Date.now(), contentType = 'application/x-ndjson' }) {
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const path = '/' + chiave.split('/').map(encodeURIComponent).join('/');
  const amzDate = new Date(dataMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const data = amzDate.slice(0, 8);
  const payloadHash = hex(corpo);
  const md5 = createHash('md5').update(corpo, 'utf8').digest('base64');
  const h = { 'content-md5': md5, 'content-type': contentType, 'host': host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const nomi = Object.keys(h).sort();
  const canon = ['PUT', path, '', nomi.map(n => `${n}:${h[n]}\n`).join(''), nomi.join(';'), payloadHash].join('\n');
  const scope = `${data}/${region}/s3/aws4_request`;
  const daFirmare = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canon)].join('\n');
  const kFirma = hmac(hmac(hmac(hmac('AWS4' + secret, data), region), 's3'), 'aws4_request');
  const firma = createHmac('sha256', kFirma).update(daFirmare, 'utf8').digest('hex');
  const headers = { ...h, 'authorization': `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${nomi.join(';')}, Signature=${firma}` };
  delete headers.host;
  return { url: `https://${host}${path}`, headers };
}

export async function scriviS3({ chiave, corpo, keyId, secret, dataMs }) {
  const { url, headers } = firmaPut({ bucket: BUCKET, chiave, corpo, keyId, secret, dataMs });
  const r = await fetch(url, { method: 'PUT', headers, body: corpo });
  if (!r.ok) throw new Error(`S3 ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`);
}

export async function eseguiRegistro({ supabaseUrl, supabaseKey, runErrors = [], now = Date.now(), scrivi = scriviS3, leggi = leggiGiorno }) {
  const esito = { giorni: [], mancanti: [] };
  const token = process.env.REGISTRO_SUPABASE_LOG_TOKEN;
  const keyId = process.env.REGISTRO_AWS_ACCESS_KEY_ID;
  const secret = process.env.REGISTRO_AWS_SECRET_ACCESS_KEY;
  try {
    // Avviso di scadenza del token dei log.
    const scade = Date.parse(TOKEN_SCADENZA + 'T00:00:00Z');
    if (now >= scade - 14 * H24) {
      runErrors.push({ ramo: 'registro', ref: 'token_log', msg: `il token dei log (registro-log-lettura) scade il ${TOKEN_SCADENZA}: crearne uno nuovo e aggiornare REGISTRO_SUPABASE_LOG_TOKEN e TOKEN_SCADENZA` });
    }
    if (!token || !keyId || !secret) throw new Error('variabili REGISTRO_* mancanti');
    const base = `${supabaseUrl}/rest/v1`;
    const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };
    const primo = giorno(Date.parse(giorno(now) + 'T00:00:00Z') - GIORNI_RECUPERO * H24);
    const f = await fetch(`${base}/audit_log?select=details&action=eq.registro_amministratori_esportato&created_at=gte.${primo}T00:00:00Z`, { headers });
    if (!f.ok) throw new Error(`lettura audit ${f.status}`);
    const fatti = new Set((await f.json()).map(x => x.details && x.details.giorno).filter(Boolean));
    const daFare = giorniDaEsportare(now, fatti);
    for (const g of daFare.slice(0, MAX_GIORNI_PER_GIRO)) {
      const righe = await leggi(g, token);
      const { corpo, sha256 } = componiFile(g, righe, new Date(now).toISOString());
      const chiave = `registro/${g.slice(0, 4)}/${g.slice(5, 7)}/${g}.jsonl`;
      await scrivi({ chiave, corpo, keyId, secret, dataMs: Date.now() });
      const a = await fetch(`${base}/audit_log`, {
        method: 'POST', headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ action: 'registro_amministratori_esportato', target_type: 'sistema', details: { giorno: g, chiave, righe: righe.length, sha256 } })
      });
      if (!a.ok) throw new Error(`traccia ${g} ${a.status} (file già scritto: il giro dopo ne scrive una nuova versione)`);
      esito.giorni.push({ giorno: g, righe: righe.length });
    }
    // Giorno al margine ancora mancante: il log di Supabase lo perde a breve.
    const margine = giorno(Date.parse(giorno(now) + 'T00:00:00Z') - GIORNI_RECUPERO * H24);
    esito.mancanti = daFare.slice(MAX_GIORNI_PER_GIRO);
    if (daFare.includes(margine) && !esito.giorni.some(x => x.giorno === margine)) {
      runErrors.push({ ramo: 'registro', ref: margine, msg: 'giorno non esportato al margine dei 7 giorni di Supabase' });
    }
  } catch (e) {
    esito.errore = e.message;
    runErrors.push({ ramo: 'registro', ref: 'registro_amministratori', msg: e.message });
    console.error('[registro]', e.message);
  }
  console.log('[registro]', JSON.stringify(esito));
  return esito;
}
