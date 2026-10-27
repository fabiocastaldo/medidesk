# Copia logica periodica del database (s98, 26–27/10/2026)

Decisione di Fabio del 26/10/2026: niente PITR né secondo progetto Supabase al go-live; copia logica due volte al giorno
in AWS eu-central-1, scadenza 90 giorni. Nulla di questo è automatizzato dal repo: i file qui sono la copia di riferimento
di ciò che gira in AWS.

- `lambda_function.py` — funzione Lambda `delphi-med-copia-db` (Python 3.12, x86_64, livello `delphi-med-pgdump17`
  con pg_dump/pg_restore/psql 17.11 da conda-forge). Avviata da EventBridge Scheduler `delphi-med-copia-db`
  alle 14:00 e 22:00 UTC. Entra nel DB col ruolo di sola lettura `backup_lettore` (pooler in modalità sessione, TLS),
  fa pg_dump di public e storage ed esporta auth con `copia.righe_auth()`; carica nel bucket S3 `delphi-med-db-backup`
  sotto `db/AAAA/MM/`. Il ruolo IAM della Lambda può solo scrivere in `db/*` e nei log.
- `ripristino_prova.sh` — ripristino di prova in CloudShell (Postgres 17 in `/tmp`, dati che restano in AWS):
  `bash ripristino_prova.sh db/2026/10/delphimed-20261026T2200Z`. Stampa impronta, tempo di ripristino, errori e i
  conteggi di tabelle e righe da confrontare con produzione.
- Il controllo quotidiano è nel cron delle 17:00 (`lib/verifica-copia-db.js`): traccia `copia_db_verificata` o
  `copia_db_mancante` in `audit_log` più alert admin.

Regola DB: ogni nuova tabella in `public` riceve `grant select on … to backup_lettore` nella stessa DDL, altrimenti la
copia fallisce (apposta) e il controllo delle 17:00 lo segnala. La DDL del ruolo e della funzione vive in `_stato\`
(fuori dal repo), come gli altri invarianti del DB.
