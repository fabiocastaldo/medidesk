-- Aggiunge campi di validità e frequenza ai turni
ALTER TABLE turni ADD COLUMN IF NOT EXISTS frequenza_settimane INTEGER DEFAULT 1;
ALTER TABLE turni ADD COLUMN IF NOT EXISTS data_inizio_validita DATE;
ALTER TABLE turni ADD COLUMN IF NOT EXISTS data_fine_validita DATE;
