-- ============================================================
-- MediDesk — Tabella chiusure (ferie e periodi di chiusura)
-- Esegui questo script nel SQL editor di Supabase
-- ============================================================

create table if not exists public.chiusure (
  id          uuid primary key default gen_random_uuid(),
  medico_id   uuid not null references public.medici(id) on delete cascade,
  data_inizio date not null,
  data_fine   date not null,
  etichetta   text,
  centri_ids  uuid[] not null default '{}',
  created_at  timestamptz not null default now()
);

-- Indice per query per medico e range di date
create index if not exists chiusure_medico_id_idx on public.chiusure(medico_id);
create index if not exists chiusure_date_idx on public.chiusure(data_inizio, data_fine);

-- RLS: ogni medico vede solo le proprie chiusure
alter table public.chiusure enable row level security;

create policy "Medico legge le sue chiusure"
  on public.chiusure for select
  using (
    medico_id = (
      select id from public.medici where user_id = auth.uid()
    )
  );

create policy "Medico inserisce le sue chiusure"
  on public.chiusure for insert
  with check (
    medico_id = (
      select id from public.medici where user_id = auth.uid()
    )
  );

create policy "Medico aggiorna le sue chiusure"
  on public.chiusure for update
  using (
    medico_id = (
      select id from public.medici where user_id = auth.uid()
    )
  );

create policy "Medico elimina le sue chiusure"
  on public.chiusure for delete
  using (
    medico_id = (
      select id from public.medici where user_id = auth.uid()
    )
  );
