-- ============================================================
-- MediDesk — Schema Supabase
-- Regione: Frankfurt (eu-central-1)
-- ============================================================
-- Esegui nell'SQL Editor di Supabase (Settings → SQL Editor).
-- Puoi eseguire il file intero in un'unica passata.
-- ============================================================


-- ──────────────────────────────────────────────────────────────
-- SEZIONE 1: TABELLE
-- ──────────────────────────────────────────────────────────────

-- 1. medici
-- Profilo professionale del medico, collegato a auth.users.
-- Ogni account autenticato corrisponde a un solo medico (user_id UNIQUE).
CREATE TABLE IF NOT EXISTS medici (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid        UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    email            text        UNIQUE,
    titolo           text,                            -- "Dr.", "Dott.", "Dott.ssa", "Prof.", "Prof.ssa"
    nome             text,
    cognome          text,
    specializzazione text,
    slug             text        UNIQUE,              -- URL pubblico della pagina di prenotazione
    numero_albo      text,
    foto_url         text,                            -- path nel bucket "fotoprofilo"
    bio              text,
    anni_esperienza  integer,
    lingue           text[],                          -- es. '{"Italiano","Inglese","Francese"}'
    email_pubblica   text,
    telefono         text,
    sito_web         text,
    linkedin         text,
    instagram        text,
    youtube          text,
    facebook         text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- 2. centri
-- Ambulatori / studi in cui il medico riceve i pazienti.
CREATE TABLE IF NOT EXISTS centri (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    medico_id        uuid        NOT NULL REFERENCES medici(id) ON DELETE CASCADE,
    nome             text        NOT NULL,
    email_segreteria text,
    indirizzo        text,
    colore           text        NOT NULL DEFAULT '#2D5F4E',
    attivo           boolean     NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- 3. turni
-- Fasce orarie ricorrenti per centro (schedule settimanale).
-- giorno: 0=domenica, 1=lunedì, …, 6=sabato (coerente con JS Date.getDay())
CREATE TABLE IF NOT EXISTS turni (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    centro_id        uuid        NOT NULL REFERENCES centri(id) ON DELETE CASCADE,
    giorno           integer     NOT NULL CHECK (giorno BETWEEN 0 AND 6),
    inizio           time        NOT NULL,
    fine             time        NOT NULL,
    durata_slot      integer     NOT NULL DEFAULT 30, -- minuti per slot
    CHECK (fine > inizio)
);

-- 4. tipi_visita
-- Tipi di visita configurabili dal medico (es. "Prima visita", "Controllo").
-- is_default = true per i tipi predefiniti non eliminabili.
CREATE TABLE IF NOT EXISTS tipi_visita (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    medico_id        uuid        NOT NULL REFERENCES medici(id) ON DELETE CASCADE,
    nome             text        NOT NULL,
    is_default       boolean     NOT NULL DEFAULT false
);

-- 5. aree_tematiche
-- Aree di intervento associabili alle visite (es. "Ginocchio", "Spalla", "Anca").
CREATE TABLE IF NOT EXISTS aree_tematiche (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    medico_id        uuid        NOT NULL REFERENCES medici(id) ON DELETE CASCADE,
    nome             text        NOT NULL
);

-- 6. pazienti
-- Archivio pazienti del medico. Non accessibili ad altri medici né ai pazienti stessi.
CREATE TABLE IF NOT EXISTS pazienti (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    medico_id        uuid        NOT NULL REFERENCES medici(id) ON DELETE CASCADE,
    nome             text        NOT NULL,
    cognome          text        NOT NULL,
    codice_fiscale   text,
    data_nascita     text,                            -- text per flessibilità di formato
    telefono         text,
    email            text,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- 7. appuntamenti
-- Appuntamenti inseriti dal medico o prenotati online dai pazienti.
-- paziente_id è nullable: può essere NULL per prenotazioni anonime online.
-- I campi *_paziente denormalizzati servono per prenotazioni online senza account.
CREATE TABLE IF NOT EXISTS appuntamenti (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    medico_id         uuid        NOT NULL REFERENCES medici(id) ON DELETE CASCADE,
    paziente_id       uuid        REFERENCES pazienti(id) ON DELETE SET NULL,
    centro_id         uuid        REFERENCES centri(id) ON DELETE SET NULL,  -- nullable: SET NULL se il centro viene eliminato
    data              date        NOT NULL,
    ora               time        NOT NULL,
    tipo_visita       text,
    area_tematica     text,
    note              text,
    nome_paziente     text,                           -- denormalizzato per prenotazioni online
    cognome_paziente  text,
    telefono_paziente text,
    email_paziente    text,
    source            text        NOT NULL DEFAULT 'medico'
                                  CHECK (source IN ('medico', 'paziente')),
    seen              boolean     NOT NULL DEFAULT false,
    created_at        timestamptz NOT NULL DEFAULT now()
);

-- 8. visite
-- Storico clinico: referti e note per ogni paziente.
-- medico_id è ridondante rispetto a pazienti.medico_id ma semplifica RLS e query.
CREATE TABLE IF NOT EXISTS visite (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    paziente_id       uuid        NOT NULL REFERENCES pazienti(id) ON DELETE CASCADE,
    medico_id         uuid        NOT NULL REFERENCES medici(id) ON DELETE CASCADE,
    data_visita       text,                           -- es. "2026-05-10"
    luogo             text,                           -- nome del centro / studio
    contenuto_clinico text,                           -- testo del referto / note cliniche
    foto_referto_url  text,                           -- path nel bucket "fotoreferti"
    created_at        timestamptz NOT NULL DEFAULT now()
);


-- ──────────────────────────────────────────────────────────────
-- SEZIONE 2: INDICI
-- Indici sulle FK e sui campi usati nelle query più frequenti.
-- ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_medici_user_id            ON medici(user_id);
CREATE INDEX IF NOT EXISTS idx_medici_slug               ON medici(slug);
CREATE INDEX IF NOT EXISTS idx_medici_email              ON medici(email);

CREATE INDEX IF NOT EXISTS idx_centri_medico_id          ON centri(medico_id);
CREATE INDEX IF NOT EXISTS idx_centri_attivo             ON centri(medico_id) WHERE attivo = true;

CREATE INDEX IF NOT EXISTS idx_turni_centro_id           ON turni(centro_id);
CREATE INDEX IF NOT EXISTS idx_turni_giorno              ON turni(centro_id, giorno);

CREATE INDEX IF NOT EXISTS idx_tipi_visita_medico_id     ON tipi_visita(medico_id);
CREATE INDEX IF NOT EXISTS idx_aree_tematiche_medico_id  ON aree_tematiche(medico_id);

CREATE INDEX IF NOT EXISTS idx_pazienti_medico_id        ON pazienti(medico_id);
CREATE INDEX IF NOT EXISTS idx_pazienti_cf               ON pazienti(codice_fiscale) WHERE codice_fiscale IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appuntamenti_medico_data  ON appuntamenti(medico_id, data);
CREATE INDEX IF NOT EXISTS idx_appuntamenti_paziente_id  ON appuntamenti(paziente_id) WHERE paziente_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appuntamenti_centro_id    ON appuntamenti(centro_id);
CREATE INDEX IF NOT EXISTS idx_appuntamenti_pending      ON appuntamenti(medico_id) WHERE source = 'paziente' AND seen = false;

CREATE INDEX IF NOT EXISTS idx_visite_paziente_id        ON visite(paziente_id);
CREATE INDEX IF NOT EXISTS idx_visite_medico_id          ON visite(medico_id);


-- ──────────────────────────────────────────────────────────────
-- SEZIONE 3: TRIGGER updated_at
-- Aggiorna automaticamente updated_at sulla tabella medici
-- ogni volta che una riga viene modificata.
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_medici_updated_at ON medici;
CREATE TRIGGER trg_medici_updated_at
    BEFORE UPDATE ON medici
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ──────────────────────────────────────────────────────────────
-- SEZIONE 4: FUNZIONE PUBBLICA get_medico_pubblico
-- Usata dalla pagina di prenotazione anonima per recuperare
-- il profilo pubblico di un medico dato il suo slug.
-- SECURITY DEFINER: si esegue con i permessi del definer (non
-- dell'utente anonimo), bypassando RLS in modo controllato.
-- Espone SOLO i campi pubblici — nessun dato sensibile.
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_medico_pubblico(p_slug text)
RETURNS TABLE (
    id               uuid,
    titolo           text,
    nome             text,
    cognome          text,
    specializzazione text,
    slug             text,
    foto_url         text,
    bio              text,
    anni_esperienza  integer,
    lingue           text[],
    email_pubblica   text,
    telefono         text,
    sito_web         text,
    linkedin         text,
    instagram        text,
    youtube          text,
    facebook         text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT
        id, titolo, nome, cognome, specializzazione, slug,
        foto_url, bio, anni_esperienza, lingue,
        email_pubblica, telefono, sito_web,
        linkedin, instagram, youtube, facebook
    FROM medici
    WHERE slug = p_slug;
$$;

-- Rendi la funzione chiamabile dagli utenti anonimi
GRANT EXECUTE ON FUNCTION public.get_medico_pubblico(text) TO anon;

-- VIEW di comodo per il medico autenticato (non usata da anon)
CREATE OR REPLACE VIEW medici_pubblici AS
SELECT
    id, titolo, nome, cognome, specializzazione, slug,
    foto_url, bio, anni_esperienza, lingue,
    email_pubblica, telefono, sito_web,
    linkedin, instagram, youtube, facebook
FROM medici;


-- ──────────────────────────────────────────────────────────────
-- SEZIONE 5: ROW LEVEL SECURITY (RLS)
-- ──────────────────────────────────────────────────────────────

-- ── 5.1 Abilita RLS su tutte le tabelle ──────────────────────

ALTER TABLE medici          ENABLE ROW LEVEL SECURITY;
ALTER TABLE centri          ENABLE ROW LEVEL SECURITY;
ALTER TABLE turni           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tipi_visita     ENABLE ROW LEVEL SECURITY;
ALTER TABLE aree_tematiche  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pazienti        ENABLE ROW LEVEL SECURITY;
ALTER TABLE appuntamenti    ENABLE ROW LEVEL SECURITY;
ALTER TABLE visite          ENABLE ROW LEVEL SECURITY;

-- ── 5.2 Funzione helper: medico_id dell'utente corrente ──────
-- Stabile e SECURITY DEFINER per evitare ricorsione RLS.

CREATE OR REPLACE FUNCTION get_medico_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT id FROM medici WHERE user_id = auth.uid() LIMIT 1;
$$;

-- ── 5.3 Policy: medici ───────────────────────────────────────

CREATE POLICY "medici: lettura proprio profilo"
    ON medici FOR SELECT
    USING (user_id = auth.uid());

CREATE POLICY "medici: creazione proprio profilo"
    ON medici FOR INSERT
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "medici: modifica proprio profilo"
    ON medici FOR UPDATE
    USING (user_id = auth.uid());

CREATE POLICY "medici: eliminazione proprio profilo"
    ON medici FOR DELETE
    USING (user_id = auth.uid());

-- ── 5.4 Policy: centri ───────────────────────────────────────

CREATE POLICY "centri: CRUD proprio medico"
    ON centri FOR ALL
    USING (medico_id = get_medico_id())
    WITH CHECK (medico_id = get_medico_id());

-- Anon: lettura centri attivi (per il form di prenotazione pubblica)
CREATE POLICY "centri: lettura pubblica attivi"
    ON centri FOR SELECT
    TO anon
    USING (attivo = true);

-- ── 5.5 Policy: turni ────────────────────────────────────────

CREATE POLICY "turni: CRUD proprio medico"
    ON turni FOR ALL
    USING  (centro_id IN (SELECT id FROM centri WHERE medico_id = get_medico_id()))
    WITH CHECK (centro_id IN (SELECT id FROM centri WHERE medico_id = get_medico_id()));

-- Anon: lettura turni (per calcolo disponibilità nella pagina pubblica)
CREATE POLICY "turni: lettura pubblica"
    ON turni FOR SELECT
    TO anon
    USING (true);

-- ── 5.6 Policy: tipi_visita ──────────────────────────────────

CREATE POLICY "tipi_visita: CRUD proprio medico"
    ON tipi_visita FOR ALL
    USING (medico_id = get_medico_id())
    WITH CHECK (medico_id = get_medico_id());

-- Anon: lettura tipi visita (per il form di prenotazione pubblica)
CREATE POLICY "tipi_visita: lettura pubblica"
    ON tipi_visita FOR SELECT
    TO anon
    USING (true);

-- ── 5.7 Policy: aree_tematiche ───────────────────────────────

CREATE POLICY "aree_tematiche: CRUD proprio medico"
    ON aree_tematiche FOR ALL
    USING (medico_id = get_medico_id())
    WITH CHECK (medico_id = get_medico_id());

-- Anon: lettura aree (per il form di prenotazione pubblica)
CREATE POLICY "aree_tematiche: lettura pubblica"
    ON aree_tematiche FOR SELECT
    TO anon
    USING (true);

-- ── 5.8 Policy: pazienti ─────────────────────────────────────

CREATE POLICY "pazienti: CRUD proprio medico"
    ON pazienti FOR ALL
    USING (medico_id = get_medico_id())
    WITH CHECK (medico_id = get_medico_id());

-- ── 5.9 Policy: appuntamenti ─────────────────────────────────

CREATE POLICY "appuntamenti: CRUD proprio medico"
    ON appuntamenti FOR ALL
    USING (medico_id = get_medico_id())
    WITH CHECK (medico_id = get_medico_id());

-- Anon: solo INSERT con source='paziente'
-- Il medico_id deve corrispondere a un medico esistente (verificato dal CHECK).
-- Nota: un utente malevolo potrebbe inserire appuntamenti per qualsiasi medico_id
-- valido — in futuro valuta di usare una RPC con SECURITY DEFINER per l'insert.
CREATE POLICY "appuntamenti: inserimento pubblico prenotazioni"
    ON appuntamenti FOR INSERT
    TO anon
    WITH CHECK (source = 'paziente');

-- ── 5.10 Policy: visite ──────────────────────────────────────

CREATE POLICY "visite: CRUD proprio medico"
    ON visite FOR ALL
    USING (medico_id = get_medico_id())
    WITH CHECK (medico_id = get_medico_id());


-- ──────────────────────────────────────────────────────────────
-- SEZIONE 6: STORAGE BUCKETS
-- Esegui questa sezione SOLO se i bucket non esistono già.
-- In alternativa, crea i bucket dall'interfaccia Supabase
-- (Storage → New bucket) e applica solo le policy.
-- ──────────────────────────────────────────────────────────────

-- ── 6.1 Bucket "fotoreferti" — PRIVATO ───────────────────────
-- Contiene le foto dei referti dei pazienti.
-- Struttura path: {user_id}/{paziente_id}/{filename}
-- Non accessibile pubblicamente: serve sempre il JWT del medico.

INSERT INTO storage.buckets (id, name, public)
VALUES ('fotoreferti', 'fotoreferti', false)
ON CONFLICT (id) DO NOTHING;

-- Il medico può caricare solo nella propria cartella radice ({user_id}/...)
CREATE POLICY "fotoreferti: upload proprio medico"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
        bucket_id = 'fotoreferti'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- Il medico può leggere solo i propri file
CREATE POLICY "fotoreferti: lettura propri file"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (
        bucket_id = 'fotoreferti'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- Il medico può eliminare solo i propri file
CREATE POLICY "fotoreferti: eliminazione propri file"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (
        bucket_id = 'fotoreferti'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- ── 6.2 Bucket "fotoprofilo" — PUBBLICO ──────────────────────
-- Contiene le foto profilo dei medici.
-- Le URL pubbliche vengono usate nella pagina di prenotazione.
-- Struttura path: {user_id}/avatar.{ext}

INSERT INTO storage.buckets (id, name, public)
VALUES ('fotoprofilo', 'fotoprofilo', true)
ON CONFLICT (id) DO NOTHING;

-- Il medico può caricare solo nella propria cartella
CREATE POLICY "fotoprofilo: upload proprio medico"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
        bucket_id = 'fotoprofilo'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- Il medico può aggiornare solo i propri file
CREATE POLICY "fotoprofilo: update propri file"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING (
        bucket_id = 'fotoprofilo'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- Il medico può eliminare solo i propri file
CREATE POLICY "fotoprofilo: eliminazione propri file"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (
        bucket_id = 'fotoprofilo'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- La lettura pubblica è gestita automaticamente da Supabase
-- perché il bucket è marcato come public = true.
-- Non serve una policy SELECT esplicita per anon su fotoprofilo.
