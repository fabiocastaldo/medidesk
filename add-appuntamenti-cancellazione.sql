-- Aggiunge campi per la cancellazione online degli appuntamenti
ALTER TABLE appuntamenti ADD COLUMN IF NOT EXISTS cancellation_token TEXT;
ALTER TABLE appuntamenti ADD COLUMN IF NOT EXISTS cancelled BOOLEAN DEFAULT FALSE;
ALTER TABLE appuntamenti ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP WITH TIME ZONE;

-- Indice per ricerche veloci per token
CREATE INDEX IF NOT EXISTS idx_appt_cancel_token
  ON appuntamenti(cancellation_token)
  WHERE cancellation_token IS NOT NULL;
