-- Aggiunge preferenze notifiche email ai centri nella tabella medici
ALTER TABLE medici ADD COLUMN IF NOT EXISTS notifica_nuova_prenotazione   BOOLEAN DEFAULT TRUE;
ALTER TABLE medici ADD COLUMN IF NOT EXISTS notifica_cancellazione         BOOLEAN DEFAULT TRUE;
ALTER TABLE medici ADD COLUMN IF NOT EXISTS notifica_appuntamento_manuale  BOOLEAN DEFAULT FALSE;
