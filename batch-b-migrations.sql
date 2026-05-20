-- ══════════════════════════════════════════════════════════════════
-- BATCH B — Minimizzazione, consenso, gestione diritti e ciclo vita
-- ⚠️  Prima di eseguire: fare dump del DB da Supabase Dashboard.
-- ══════════════════════════════════════════════════════════════════

-- B.1 Rimozione CF medico (non necessario per il trattamento dell'agenda)
ALTER TABLE medici DROP COLUMN IF EXISTS codice_fiscale;

-- B.3 Toggle estrazione CF dai referti AI (default FALSE = off)
ALTER TABLE medici ADD COLUMN IF NOT EXISTS estrai_cf_referti BOOLEAN DEFAULT FALSE;

-- B.4 Consensi espliciti sulla prenotazione pubblica
ALTER TABLE appuntamenti ADD COLUMN IF NOT EXISTS consenso_base_at TIMESTAMPTZ;
ALTER TABLE appuntamenti ADD COLUMN IF NOT EXISTS consenso_health_at TIMESTAMPTZ;

-- B.6 Soft-delete account medico (30 giorni grace period)
ALTER TABLE medici ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE medici ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ;

-- B.7 Audit log per operazioni GDPR-sensitive
CREATE TABLE IF NOT EXISTS audit_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medico_id         UUID REFERENCES medici(id) ON DELETE SET NULL,
  action            TEXT NOT NULL,
  target_type       TEXT,
  target_id         TEXT,
  details           JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_medico_idx
  ON audit_log(medico_id, created_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Solo il medico può leggere i propri log
DROP POLICY IF EXISTS audit_log_select_own ON audit_log;
CREATE POLICY audit_log_select_own ON audit_log
  FOR SELECT
  USING (
    medico_id IN (SELECT id FROM medici WHERE user_id = auth.uid())
  );

-- Solo il medico può inserire log propri
DROP POLICY IF EXISTS audit_log_insert_own ON audit_log;
CREATE POLICY audit_log_insert_own ON audit_log
  FOR INSERT
  WITH CHECK (
    medico_id IN (SELECT id FROM medici WHERE user_id = auth.uid())
  );

-- Nessuna policy per UPDATE/DELETE → bloccati per tutti (incluso il medico)

-- B.8 Soglia di conservazione dei dati clinici (default 10 anni)
ALTER TABLE medici ADD COLUMN IF NOT EXISTS soglia_conservazione_anni INTEGER DEFAULT 10;
