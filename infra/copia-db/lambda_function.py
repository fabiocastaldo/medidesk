"""Delphi~Med — copia logica periodica del DB (s98, 26/10/2026).

Avviata da EventBridge Scheduler alle 14:00 e 22:00 UTC. Entra nel DB col ruolo di sola
lettura `backup_lettore` (pooler Supavisor, modalità sessione, TLS obbligatorio), esegue
pg_dump 17 (formato custom) degli schemi public e storage e carica il file nel bucket S3
sotto db/AAAA/MM/. Le tabelle di storage che il ruolo non può leggere (gestite da Supabase,
non concedibili da postgres) sono escluse leggendole dal catalogo a ogni giro; in public
nessuna esclusione: una tabella senza grant fa fallire la copia, apposta.
Lo schema auth (di supabase_admin, USAGE non concedibile da postgres) si esporta con la
funzione copia.righe_auth() (DEFINER, eseguibile solo da backup_lettore): tutte le tabelle
di auth come righe JSON in un secondo file .auth.jsonl.gz con lo stesso nome di base.
Nessuna scrittura sul DB. La verifica e la traccia in audit_log le fa il cron delle 17:00.
"""
import datetime
import gzip
import hashlib
import os
import subprocess

import boto3

BIN = "/opt/bin"
SCHEMI = ("public", "storage")
CATALOGO = (
    "select c.relkind::text || ' ' || format('%I.%I', n.nspname, c.relname) "
    "from pg_class c join pg_namespace n on n.oid = c.relnamespace "
    "where n.nspname = 'storage' and c.relkind in ('r','p','S') "
    "and not has_table_privilege(current_user, c.oid, 'SELECT') order by 1"
)


def _env():
    e = dict(os.environ)
    e.update(PGSSLMODE=os.environ.get("PGSSLMODE", "require"), PGCONNECT_TIMEOUT="20",
             PGAPPNAME="delphi-med-copia-db")
    return e


def _esclusioni(env):
    out = subprocess.run([f"{BIN}/psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", CATALOGO],
                         env=env, capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError("lettura catalogo fallita: " + out.stderr.strip()[:500])
    tabelle, sequenze = [], []
    for riga in out.stdout.splitlines():
        kind, nome = riga.split(" ", 1)
        (sequenze if kind == "S" else tabelle).append(nome)
    return tabelle, sequenze


def lambda_handler(event, context):
    env = _env()
    bucket = os.environ["BUCKET"]
    ora = datetime.datetime.now(datetime.timezone.utc)
    nome = ora.strftime("delphimed-%Y%m%dT%H%MZ.dump")
    chiave = ora.strftime("db/%Y/%m/") + nome
    percorso = "/tmp/" + nome

    tabelle, sequenze = _esclusioni(env)
    cmd = [f"{BIN}/pg_dump", "-Fc", "-Z", "6", "-f", percorso]
    for s in SCHEMI:
        cmd += ["-n", s]
    cmd += [f"--exclude-table={t}" for t in tabelle]
    cmd += [f"--exclude-table-data={s}" for s in sequenze]
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise RuntimeError("pg_dump fallito: " + r.stderr.strip()[:1000])

    grezzo = percorso[:-5] + ".auth.jsonl"
    r = subprocess.run([f"{BIN}/psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-o", grezzo, "-c",
                        "select jsonb_build_object('t', tabella, 'r', riga)::text from copia.righe_auth()"],
                       env=env, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError("esportazione auth fallita: " + r.stderr.strip()[:1000])
    righe_auth = sum(1 for _ in open(grezzo, "rb"))
    percorso_auth = grezzo + ".gz"
    with open(grezzo, "rb") as src, gzip.open(percorso_auth, "wb", 6) as dst:
        dst.writelines(src)
    os.remove(grezzo)

    s3 = boto3.client("s3")
    caricati = []
    for file, k, meta in ((percorso, chiave, {"pg-dump": "17", "escluse": str(len(tabelle) + len(sequenze))}),
                          (percorso_auth, chiave[:-5] + ".auth.jsonl.gz", {"righe": str(righe_auth)})):
        h = hashlib.sha256()
        with open(file, "rb") as f:
            for blocco in iter(lambda: f.read(1 << 20), b""):
                h.update(blocco)
        meta["sha256"] = h.hexdigest()
        with open(file, "rb") as f:
            s3.put_object(Bucket=bucket, Key=k, Body=f, ContentType="application/octet-stream",
                          ServerSideEncryption="AES256", Metadata=meta)
        caricati.append({"chiave": k, "byte": os.path.getsize(file), "sha256": h.hexdigest()})
        os.remove(file)
    esito = {"file": caricati, "righe_auth": righe_auth,
             "tabelle_escluse": tabelle, "sequenze_senza_dati": sequenze}
    print(esito)
    return esito
