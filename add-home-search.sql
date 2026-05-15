-- ──────────────────────────────────────────────────────────────
-- Delphi Med — Home pubblica: ricerca medici per nome/cognome/specializzazione
-- Esegui nell'SQL Editor di Supabase.
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.search_medici_pubblici(p_query text)
RETURNS TABLE (
    id               uuid,
    titolo           text,
    nome             text,
    cognome          text,
    specializzazione text,
    slug             text,
    foto_url         text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT id, titolo, nome, cognome, specializzazione, slug, foto_url
    FROM medici
    WHERE slug IS NOT NULL
      AND (
        nome             ILIKE '%' || p_query || '%'
        OR cognome       ILIKE '%' || p_query || '%'
        OR specializzazione ILIKE '%' || p_query || '%'
      )
    ORDER BY cognome, nome
    LIMIT 20;
$$;

-- Rendi la funzione chiamabile dagli utenti anonimi (home pubblica)
GRANT EXECUTE ON FUNCTION public.search_medici_pubblici(text) TO anon;
