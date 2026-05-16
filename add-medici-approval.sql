-- Aggiunge i campi necessari per il flusso di registrazione con approvazione manuale

ALTER TABLE medici
  ADD COLUMN IF NOT EXISTS codice_fiscale          text,
  ADD COLUMN IF NOT EXISTS numero_iscrizione_ordine text,
  ADD COLUMN IF NOT EXISTS provincia_ordine         text,
  ADD COLUMN IF NOT EXISTS stato                    text NOT NULL DEFAULT 'approvato';

-- I medici esistenti restano 'approvato' (account legacy: accesso immediato).
-- I nuovi registrati via form ricevono 'in_attesa' e attendono l'approvazione manuale.

CREATE INDEX IF NOT EXISTS idx_medici_stato ON medici(stato);
