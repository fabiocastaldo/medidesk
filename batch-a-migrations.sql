-- batch-a-migrations.sql — Batch A Sicurezza (2026-05-20)
-- Eseguire UNA VOLTA nel SQL Editor di Supabase (Settings → SQL Editor)

-- Tabella rate_limits: un record per ogni richiesta tracciata
CREATE TABLE IF NOT EXISTS rate_limits (
  id           BIGSERIAL PRIMARY KEY,
  endpoint     TEXT NOT NULL,
  ip           TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rate_limits_lookup ON rate_limits(endpoint, ip, window_start DESC);

-- RPC SECURITY DEFINER: controlla il rate limit.
-- Restituisce TRUE se la richiesta è consentita, FALSE se il limite è stato superato.
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_endpoint       TEXT,
  p_ip             TEXT,
  p_max_count      INTEGER,
  p_window_seconds INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count        INTEGER;
  v_window_start TIMESTAMPTZ;
BEGIN
  v_window_start := NOW() - (p_window_seconds || ' seconds')::INTERVAL;

  -- Conta richieste nella finestra temporale
  SELECT COALESCE(SUM(count), 0) INTO v_count
  FROM rate_limits
  WHERE endpoint = p_endpoint
    AND ip = p_ip
    AND window_start > v_window_start;

  IF v_count >= p_max_count THEN
    RETURN FALSE; -- limite superato
  END IF;

  -- Registra la nuova richiesta
  INSERT INTO rate_limits(endpoint, ip, count, window_start)
  VALUES (p_endpoint, p_ip, 1, NOW());

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION check_rate_limit(TEXT, TEXT, INTEGER, INTEGER) TO anon, authenticated;

-- Pulizia record scaduti (eseguire periodicamente o con cron)
-- DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '2 hours';
