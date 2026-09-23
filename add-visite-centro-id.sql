-- LF-10 (s34, 23/09/2026): la visita punta al centro per id, non solo per nome.
-- Eseguita su prod il 23/09/2026 su mandato di Fabio. Idempotente.
alter table public.visite add column if not exists centro_id uuid references public.centri(id) on delete set null;
create index if not exists visite_centro_id_idx on public.visite(centro_id);
-- Aggancio delle visite esistenti per nome esatto del centro, dentro lo stesso medico.
update public.visite v set centro_id = c.id
  from public.centri c
 where v.centro_id is null and v.luogo is not null
   and c.medico_id = v.medico_id
   and lower(trim(c.nome)) = lower(trim(v.luogo));
notify pgrst, 'reload schema';
