// lib/verifica-copia-db.js
// Verifica della copia logica periodica del database (s98, 27/10/2026; decisione di Fabio del 26/10: copia
// logica in AWS al posto del PITR).
//
// Chi fa la copia: la Lambda `delphi-med-copia-db` (eu-central-1), avviata da EventBridge Scheduler alle 14:00 e
// 22:00 UTC, entra nel DB col ruolo di sola lettura `backup_lettore` (pooler in modalità sessione, TLS), fa
// pg_dump 17 di public e storage ed esporta auth con la funzione copia.righe_auth(); carica nel bucket S3
// `delphi-med-db-backup` due file con lo stesso nome di base sotto db/AAAA/MM/:
//   delphimed-AAAAMMGGTHHMMZ.dump           (formato custom di pg_dump)
//   delphimed-AAAAMMGGTHHMMZ.auth.jsonl.gz  (tutte le tabelle di auth come righe JSON)
// Scadenza 90 giorni dalla regola del ciclo di vita del bucket. La Lambda non scrive nel DB.
//
// Cosa fa questo modulo: nel cron delle 17:00 (api/send-reminders) elenca il prefisso db/ del bucket (ListBucket
// con le chiavi REGISTRO_AWS_*, utente delphi-med-registro-writer) e scrive in audit_log una traccia
// `copia_db_verificata` se l'ultima copia è completa (entrambi i file, non vuoti), recente (al più ETA_MAX_MIN
// minuti: alle 17:00 deve esserci quella delle 14:00) e di dimensione plausibile (dump non sotto la metà del
// precedente); altrimenti `copia_db_mancante` con il motivo, più l'alert admin via runErrors. Così si vede anche una
// Lambda che non è mai partita: la Lambda non può lasciare tracce in audit_log (ruolo di sola lettura), il controllo
// le lascia da qui. Il ripristino di prova non è automatico: si fa in CloudShell (infra/copia-db/ripristino_prova.sh).

import { elencoS3 } from './backup-storage.js';
import { tracciaFallimento } from './registro-amministratori.js';

export const BUCKET_COPIA_DB = 'delphi-med-db-backup';
export const PREFISSO = 'db/';
export const ETA_MAX_MIN = 4 * 60;          // 14:00 → 17:00 con margine
export const FINESTRA_COPIE_MIN = 26 * 60;  // 22:00 di ieri + 14:00 di oggi
export const COPIE_ATTESE = 2;
export const BYTE_MINIMI_DUMP = 100 * 1024; // sotto, il dump è monco anche se esiste
export const ACTION_OK = 'copia_db_verificata';
export const ACTION_KO = 'copia_db_mancante';

const RE_NOME = /^db\/\d{4}\/\d{2}\/delphimed-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z\.(dump|auth\.jsonl\.gz)$/;

// Raggruppa le chiavi del bucket per istante della copia: Map iso -> { quando(ms), dump, auth }.
export function raggruppaCopie(elenco) {
  const copie = new Map();
  for (const [chiave, info] of elenco) {
    const m = RE_NOME.exec(chiave);
    if (!m) continue;
    const quando = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    const iso = new Date(quando).toISOString();
    const c = copie.get(iso) || { quando, dump: null, auth: null };
    c[m[6] === 'dump' ? 'dump' : 'auth'] = info.byte;
    copie.set(iso, c);
  }
  return copie;
}

// Giudizio puro, senza rete: { ok, motivo, ultima, eta_min, byte_dump, byte_auth, copie_finestra, precedente_byte }.
export function valutaCopie(elenco, now = Date.now()) {
  const copie = [...raggruppaCopie(elenco).entries()]
    .map(([iso, c]) => ({ iso, ...c, completa: c.dump != null && c.auth != null && c.dump >= BYTE_MINIMI_DUMP && c.auth > 0 }))
    .sort((a, b) => b.quando - a.quando);
  const complete = copie.filter(c => c.completa);
  const esito = { ok: false, motivo: null, copie_totali: copie.length, copie_finestra: 0, ultima: null, eta_min: null, byte_dump: null, byte_auth: null, precedente_byte: null };
  if (!complete.length) { esito.motivo = copie.length ? 'nessuna copia completa nel bucket' : 'bucket vuoto'; return esito; }
  const u = complete[0];
  Object.assign(esito, { ultima: u.iso, eta_min: Math.round((now - u.quando) / 60000), byte_dump: u.dump, byte_auth: u.auth });
  esito.copie_finestra = complete.filter(c => now - c.quando <= FINESTRA_COPIE_MIN * 60000).length;
  const prec = complete[1];
  if (prec) esito.precedente_byte = prec.dump;
  if (esito.eta_min > ETA_MAX_MIN) esito.motivo = `ultima copia completa troppo vecchia (${esito.eta_min} min)`;
  else if (prec && u.dump < prec.dump / 2) esito.motivo = `dump sotto la metà del precedente (${u.dump} < ${prec.dump} / 2)`;
  else if (esito.copie_finestra < COPIE_ATTESE) esito.motivo = `solo ${esito.copie_finestra} copie complete nelle ultime ${FINESTRA_COPIE_MIN / 60} ore`;
  else esito.ok = true;
  return esito;
}

export async function eseguiVerificaCopiaDb({ supabaseUrl, supabaseKey, runErrors = [], now = Date.now(), elenca = elencoS3 }) {
  const keyId = process.env.REGISTRO_AWS_ACCESS_KEY_ID;
  const secret = process.env.REGISTRO_AWS_SECRET_ACCESS_KEY;
  const base = `${supabaseUrl}/rest/v1`;
  const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };
  let esito;
  try {
    if (!keyId || !secret) throw new Error('variabili REGISTRO_AWS_* mancanti');
    const elenco = await elenca({ bucket: BUCKET_COPIA_DB, prefisso: PREFISSO, keyId, secret });
    esito = valutaCopie(elenco, now);
  } catch (e) {
    esito = { ok: false, motivo: `elenco del bucket fallito: ${e.message}` };
  }
  const { ok, ...dettagli } = esito;
  const action = ok ? ACTION_OK : ACTION_KO;
  esito.traccia = await tracciaFallimento({ base, headers, ramo: 'verifica-copia-db', action,
    details: { bucket: BUCKET_COPIA_DB, ...dettagli } });
  if (!ok) runErrors.push({ ramo: 'verifica-copia-db', ref: BUCKET_COPIA_DB, msg: esito.motivo });
  return esito;
}
