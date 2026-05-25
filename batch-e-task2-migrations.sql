-- Eseguire da Supabase SQL Editor prima del deploy

ALTER TABLE turni
  ADD COLUMN notified_60d_at TIMESTAMPTZ NULL,
  ADD COLUMN notified_30d_at TIMESTAMPTZ NULL;

CREATE INDEX idx_turni_scadenza_check
  ON turni(data_fine_validita)
  WHERE data_fine_validita IS NOT NULL;
