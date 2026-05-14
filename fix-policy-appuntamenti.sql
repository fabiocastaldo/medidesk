-- ============================================================
-- DIAGNOSI: esegui prima per capire lo stato attuale
-- ============================================================

-- 1. Quante righe ci sono in appuntamenti (eseguire come service_role / SQL editor)
SELECT count(*) AS totale, source, seen
FROM appuntamenti
GROUP BY source, seen;

-- 2. Ultime prenotazioni da paziente
SELECT id, medico_id, centro_id, data, ora,
       nome_paziente, cognome_paziente,
       source, seen, created_at
FROM appuntamenti
WHERE source = 'paziente'
ORDER BY created_at DESC
LIMIT 10;

-- 3. Verifica che medico_id corrisponda a medici.id (non a auth.users.id)
SELECT a.id, a.medico_id, m.id AS medici_id, m.user_id
FROM appuntamenti a
LEFT JOIN medici m ON m.id = a.medico_id
ORDER BY a.created_at DESC
LIMIT 5;

-- 4. Policy attualmente attive su appuntamenti
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE tablename = 'appuntamenti';

-- ============================================================
-- FIX: elimina policy errate e ricrea quelle corrette
-- ============================================================

-- Abilita RLS (idempotente)
ALTER TABLE appuntamenti ENABLE ROW LEVEL SECURITY;

-- Rimuovi tutte le policy esistenti sulla tabella appuntamenti
-- (lista i nomi con la query sopra, poi adattare se diversi)
DROP POLICY IF EXISTS "Enable read access for all users"  ON appuntamenti;
DROP POLICY IF EXISTS "Enable insert for all users"       ON appuntamenti;
DROP POLICY IF EXISTS "Enable update for all users"       ON appuntamenti;
DROP POLICY IF EXISTS "Enable delete for all users"       ON appuntamenti;
DROP POLICY IF EXISTS "medico_select_own"                 ON appuntamenti;
DROP POLICY IF EXISTS "medico_update_own"                 ON appuntamenti;
DROP POLICY IF EXISTS "medico_delete_own"                 ON appuntamenti;
DROP POLICY IF EXISTS "anon_insert_booking"               ON appuntamenti;
DROP POLICY IF EXISTS "auth_insert_booking"               ON appuntamenti;
DROP POLICY IF EXISTS "insert_appuntamento"               ON appuntamenti;
DROP POLICY IF EXISTS "select_appuntamento"               ON appuntamenti;
DROP POLICY IF EXISTS "update_appuntamento"               ON appuntamenti;
DROP POLICY IF EXISTS "delete_appuntamento"               ON appuntamenti;

-- ── SELECT: il medico autenticato vede solo i propri appuntamenti
--   NOTA: medico_id è medici.id (non auth.uid() direttamente!)
CREATE POLICY "medico_select_own" ON appuntamenti
  FOR SELECT
  TO authenticated
  USING (
    medico_id IN (
      SELECT id FROM medici WHERE user_id = auth.uid()
    )
  );

-- ── INSERT (anon): il paziente anonimo può inserire prenotazioni
CREATE POLICY "anon_insert_booking" ON appuntamenti
  FOR INSERT
  TO anon
  WITH CHECK (source = 'paziente');

-- ── INSERT (authenticated): il medico può inserire appuntamenti propri
CREATE POLICY "auth_insert_booking" ON appuntamenti
  FOR INSERT
  TO authenticated
  WITH CHECK (
    medico_id IN (
      SELECT id FROM medici WHERE user_id = auth.uid()
    )
  );

-- ── UPDATE: il medico aggiorna solo i propri (es. seen = true)
CREATE POLICY "medico_update_own" ON appuntamenti
  FOR UPDATE
  TO authenticated
  USING (
    medico_id IN (
      SELECT id FROM medici WHERE user_id = auth.uid()
    )
  );

-- ── DELETE: il medico elimina solo i propri
CREATE POLICY "medico_delete_own" ON appuntamenti
  FOR DELETE
  TO authenticated
  USING (
    medico_id IN (
      SELECT id FROM medici WHERE user_id = auth.uid()
    )
  );

-- ── SELECT (anon): per cancellazione tramite token paziente
--   Permette al paziente di leggere il proprio appuntamento via cancellation_token
--   (usato dalla pagina di cancellazione ?cancel=TOKEN)
CREATE POLICY "anon_select_by_token" ON appuntamenti
  FOR SELECT
  TO anon
  USING (cancellation_token IS NOT NULL);

-- ── UPDATE (anon): il paziente può cancellare tramite token
CREATE POLICY "anon_cancel_by_token" ON appuntamenti
  FOR UPDATE
  TO anon
  USING (cancellation_token IS NOT NULL)
  WITH CHECK (cancellation_token IS NOT NULL);

-- ============================================================
-- VERIFICA FINALE: dopo aver eseguito il fix
-- ============================================================

-- Controlla che le policy siano state create correttamente
SELECT policyname, cmd, roles
FROM pg_policies
WHERE tablename = 'appuntamenti'
ORDER BY cmd, policyname;

-- Test SELECT come medico: se ritorna righe, la policy SELECT funziona
-- (da eseguire loggato come medico in Supabase — non come service_role)
-- SELECT * FROM appuntamenti LIMIT 5;
