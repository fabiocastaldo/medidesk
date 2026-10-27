#!/bin/bash
# Ripristino di prova della copia logica s98 in CloudShell (dati restano in AWS eu-central-1)
B=$1; cd /tmp/cdb; P=/tmp/cdb/pg17/bin; export LD_LIBRARY_PATH=/tmp/cdb/pg17/lib
aws s3 cp --quiet s3://delphi-med-db-backup/$B.dump r.dump && aws s3 cp --quiet s3://delphi-med-db-backup/$B.auth.jsonl.gz r.auth.gz || exit 1
echo "sha dump  $(sha256sum r.dump | cut -c1-16)  meta $(aws s3api head-object --bucket delphi-med-db-backup --key $B.dump --query Metadata.sha256 --output text | cut -c1-16)"
$P/pg_ctl -D rdata stop -m immediate >/dev/null 2>&1; rm -rf rdata; $P/initdb -D rdata -U postgres -A trust >/dev/null
$P/pg_ctl -D rdata -o "-p 55433 -k /tmp/cdb -c listen_addresses=''" -l rlog start >/dev/null; sleep 2
Q="$P/psql -X -q -h /tmp/cdb -p 55433 -U postgres -d postgres"
$Q -c "create role anon nologin; create role authenticated nologin; create role service_role nologin; create role supabase_admin; create role supabase_storage_admin; create role backup_lettore;
create schema auth; create schema net; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as 'select null::uuid';
create function auth.jwt() returns jsonb language sql stable as 'select null::jsonb';
create function auth.role() returns text language sql stable as 'select null::text';
create table auth._auth(t text, r jsonb);"
gunzip -c r.auth.gz | python3 -c "
import sys,json
for l in sys.stdin:
    d=json.loads(l); sys.stdout.write(d['t']+'\t'+json.dumps(d['r']).replace('\\\\','\\\\\\\\')+'\n')" | $Q -c "\copy auth._auth from stdin"
$Q -c "insert into auth.users select (r->>'id')::uuid from auth._auth where t='auth.users'"
T0=$(date +%s.%N)
$P/pg_restore -h /tmp/cdb -p 55433 -U postgres -d postgres --no-owner --no-privileges r.dump 2>rerr.txt
T1=$(date +%s.%N)
echo "RTO_s $(python3 -c "print(round($T1-$T0,1))")  errori_restore $(grep -c '^pg_restore: error' rerr.txt)"
grep '^pg_restore: error' -A1 rerr.txt | grep -v '^--' | sed 's/pg_restore: error: //' | cut -c1-140 | sort | uniq -c | sort -rn | head -8
$Q -At -c "select md5(string_agg(t||':'||n, ',' order by t)), sum(n), count(*) from (select format('%I.%I',schemaname,relname) t, (xpath('/row/c/text()', query_to_xml(format('select count(*) c from %I.%I',schemaname,relname),false,true,'')))[1]::text::bigint n from pg_stat_user_tables where schemaname in ('public','storage')) x"
$Q -At -c "select string_agg(t||':'||n, ',' order by t) from (select t, count(*) n from auth._auth group by t) x"
