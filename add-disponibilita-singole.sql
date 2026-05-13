-- Tabella per giornate di disponibilità singole (non ricorrenti)
CREATE TABLE IF NOT EXISTS disponibilita_singole (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medico_id     UUID NOT NULL REFERENCES medici(id) ON DELETE CASCADE,
  centro_id     UUID NOT NULL REFERENCES centri(id) ON DELETE CASCADE,
  data          DATE NOT NULL,
  inizio        TIME NOT NULL,
  fine          TIME NOT NULL,
  durata_slot   INTEGER NOT NULL DEFAULT 30,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indice per query per centro e data
CREATE INDEX IF NOT EXISTS idx_disp_singole_centro_data
  ON disponibilita_singole(centro_id, data);

-- RLS: solo il medico proprietario può vedere/modificare
ALTER TABLE disponibilita_singole ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Medico vede le proprie disponibilità singole"
  ON disponibilita_singole FOR SELECT
  USING (medico_id = auth.uid());

CREATE POLICY "Medico inserisce le proprie disponibilità singole"
  ON disponibilita_singole FOR INSERT
  WITH CHECK (medico_id = auth.uid());

CREATE POLICY "Medico elimina le proprie disponibilità singole"
  ON disponibilita_singole FOR DELETE
  USING (medico_id = auth.uid());
