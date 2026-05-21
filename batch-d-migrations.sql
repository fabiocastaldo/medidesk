-- Batch D — Minimizzazione GDPR: rimozione CF paziente + toggle estrazione AI
-- ESEGUIRE manualmente nel Supabase SQL Editor PRIMA del merge su master.
-- Operazioni irreversibili (DROP COLUMN).

ALTER TABLE pazienti DROP COLUMN IF EXISTS cf;
ALTER TABLE medici DROP COLUMN IF EXISTS estrai_cf_referti;
