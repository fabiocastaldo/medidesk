# MediDesk — Roadmap & TODO

## Decisioni di design

### Filosofia del prodotto
- **Strumento del medico, non marketplace.** MediDesk è un'agenda digitale personale per il medico: gestisce appuntamenti, pazienti e studio. Non è una piattaforma pubblica dove i pazienti cercano medici.
- **No recensioni pubbliche.** Il profilo del medico esiste solo per la pagina di prenotazione condivisa direttamente dal medico ai suoi pazienti (via link/WhatsApp/QR code), non per l'acquisizione di nuovi clienti tramite ricerca.
- **Scenario A: medico singolo, database proprio.** Ogni medico ha un account Supabase separato (attualmente condiviso per lo sviluppo). In futuro si valuterà il multi-tenant su un unico Supabase con RLS per isolare i dati.
- **Single-file HTML.** Nessun build system, nessun framework: tutto in `medidesk.html` per massima portabilità e semplicità di deployment. Può girare su qualsiasi hosting statico.
- **Offline-first con sync Supabase.** Lo stato vive in `localStorage` (`medidesk_v2`) e viene sincronizzato su Supabase quando online. Le operazioni critiche hanno fallback locale.

### Scelte tecniche principali
- **Supabase** per auth, DB (PostgreSQL) e storage foto referti.
- **RLS (Row Level Security)** per isolare i dati del medico; policy anon per prenotazioni pubbliche.
- **`get_medico_pubblico(slug)`** — funzione SECURITY DEFINER accessibile ad anon: espone solo i campi pubblici del medico per la pagina di prenotazione.
- **UUID** come chiave primaria su tutte le tabelle (vs `Date.now()` dei dati locali precedenti); comparazioni sempre via `String(a)===String(b)`.
- **Capitalizzazione intelligente** su tutti i campi nome/cognome (italiana: particelle, apostrofi, trattini).

---

## Completati

### Infrastruttura base
- [x] App single-file `medidesk.html` con localStorage
- [x] Agenda settimanale e mensile
- [x] Gestione centri, turni, slot
- [x] Anagrafica pazienti + storico visite
- [x] Pagina prenotazione pubblica (link/QR/WhatsApp)
- [x] Profilo medico esteso (slug, social, bio, lingue, albo)
- [x] Sintesi storia clinica AI (claude-sonnet)
- [x] QR code per presentazione a schermo intero

### Migrazione Supabase
- [x] **Step 3** — Integrazione Supabase + autenticazione (login/registrazione/logout)
- [x] **Step 4.1** — Profilo medico (`medici` table): load/save/slug validation con debounce
- [x] **Step 4.2** — Centri e turni (`centri`, `turni` tables): CRUD completo
- [x] **Step 4.3** — Tipi visita e aree tematiche (`tipi_visita`, `aree_tematiche`)
- [x] **Step 4.4** — Pazienti anagrafici (`pazienti` table); visite restano locali (→ 4.6)
- [x] **Step 4.5** — Appuntamenti (`appuntamenti` table):
  - `loadAppuntamentiFromDB` all'avvio
  - `saveAppuntamento` / `deleteAppuntamento` / `markSeen` async con Supabase
  - `confirmBooking` anonima con INSERT su Supabase
  - `bkInit` async: path anonimo carica profilo+centri+tipi da DB via RPC e RLS anon
  - `get_slot_occupati(uuid)` — funzione SQL SECURITY DEFINER per slot occupati accessibili ad anon; `getSlots` controlla anche `bk.slotOccupati`

---

## In corso

---

## Da fare a breve

### Step 4.6 — Visite migrate a Supabase ✅
- [x] `saveVisita`: INSERT su `visite`, upload foto su `fotoreferti`, loading state ("Upload foto..." / "Salvataggio..."), confirm se upload fallisce, rollback foto se INSERT DB fallisce
- [x] `loadVisiteFromDB(user)`: query singola su `visite WHERE medico_id`, distribuisce ai pazienti
- [x] `migrateLocalVisite()`: one-shot migrazione localStorage → DB (flag `visite_migrated`), chiamata prima di `loadPazientiFromDB`
- [x] `loadPazientiFromDB`: ripulita, solo anagrafica (`visite:[]`); delegato a `loadVisiteFromDB`
- [x] `deleteVisita(pazId, visitaId)`: DELETE DB + remove storage + re-render scheda
- [x] `deletePaziente`: elimina foto da storage prima del DELETE CASCADE DB
- [x] Bottone 🗑 per-visita nella scheda paziente (stopPropagation per toggle)
- [x] `openFotoReferto`: signed URL on-demand (1h), apre in nuova tab
- [x] Fix CF bug: `document.getElementById('ex-cf')?.value.trim()`
- [x] `V.refertoFile`: conservato dopo AI extraction, resetato in `resetVisitaUpload`

### Step 4.7 — Foto profilo su Supabase Storage ✅
- [x] Upload foto profilo su bucket `fotoprofilo` (pubblico): ridimensionamento canvas max 400×400, JPEG 0.85
- [x] Path: `{uid}/avatar.jpg` (upsert — sovrascrive senza creare duplicati)
- [x] URL pubblico salvato in `medici.foto_url` e `S.settings.foto_url`
- [x] `renderFotoProfilo()`: mostra img se URL presente, altrimenti fallback iniziali
- [x] `removeFotoProfilo()`: rimuove da storage + `foto_url = null` in DB
- [x] Fallback offline: base64 in localStorage se `supabaseClient` è null
- [x] Foto visibile nella pagina prenotazione pubblica (`bkInit` anon e loggato)
- [x] Policy RLS storage `fotoprofilo`: INSERT/UPDATE/DELETE solo per `auth.uid() = foldername[1]`; SELECT pubblica

### UX e fix recenti ✅
- [x] Doppio click (desktop) / long press 500ms (mobile) sul calendario mensile → passa alla vista settimana sul giorno selezionato
- [x] Hint contestuale sotto il calendario mensile ("Doppio click / Tieni premuto per aprire la settimana")
- [x] Capitalizzazione automatica (`capitalizeName`) su campi "Tipo di visita" e "Area tematica" (onblur + al salvataggio)
- [x] Modal di conferma prima di eliminare un turno (con dettagli giorno/orario e avviso slot prenotati)
- [x] Fix `deleteCentro`: FK `appuntamenti.centro_id` cambiato da `NOT NULL / NO ACTION` a nullable `ON DELETE SET NULL` — eliminare un centro conserva tutti gli appuntamenti e fascicoli

### Migliorie 2026-05-13 ✅

**Festività e ferie:**
- [x] `isHoliday(dateStr)` con algoritmo di Meeus per Pasqua/Pasquetta + 10 festività fisse italiane
- [x] Calendario mensile: sfondo warm per festività, punto arancione, nome festività, icona 🏖 per chiusure, ⚠️ se ci sono appuntamenti in festività, opacità 0.5 per centri disattivati nella legenda
- [x] Calendario settimanale: day-tab con nome festività/chiusura in piccolo sotto la data
- [x] Avviso modal dopo `saveTurno()` se il turno ricorrente cade su festività nei prossimi 90 giorni → opzione "Escludi festività" (aggiunge chiusure puntuali)
- [x] Vista **🏖 Ferie** (3° tab agenda): CRUD periodi di chiusura con etichetta, range date, selezione centri
- [x] `isChiusura()` integrata in `getSlots()`: gli slot non vengono generati nei giorni di chiusura
- [x] Bozza mail automatica per ogni centro coinvolto dopo salvataggio chiusura
- [x] Tabella Supabase `chiusure` con RLS + `loadChiusureFromDB()` (eseguito `add-chiusure-table.sql`)

**Pazienti per centro:**
- [x] `renderPazienti()` raggruppa per centro con header colorato collassabile
- [x] Un paziente appartiene a un centro se ha visite con `luogo = nome centro` o appuntamenti con `centroId`
- [x] Gruppo "Senza centro" in fondo; ricerca attiva → lista piatta come prima

**Condivisione sintesi clinica:**
- [x] jsPDF incluso da CDN nel `<head>`
- [x] Pulsanti 📤 Condividi / 📧 Email / ⬇️ PDF in fondo alla **storia clinica sintetizzata** (non sui singoli referti)
- [x] `shareStoria()`: Web Share API con fallback clipboard
- [x] `emailStoria()`: apre `mailto:` con oggetto e corpo precompilati
- [x] `downloadStoriaPDF()`: PDF A4 con intestazione medico, dati paziente, storia AI, footer
- [x] `_esc()`: HTML-escape del contenuto clinico prima dell'inserimento via innerHTML

**Bug fix centri:**
- [x] Campo `centroNome` in ogni appuntamento come fallback se il centro viene eliminato
- [x] `saveCentro()` aggiorna il calendario mensile se è la vista attiva (bug B)
- [x] Legenda mese include centri disattivati (opacity 0.5) e centri eliminati con nome salvato

**Ordine tipi visita:**
- [x] `sortTipiVisita()`: "Prima visita" sempre primo, "Controllo" sempre secondo, resto alfabetico
- [x] Applicato in `load()`, `loadTipiVisitaFromDB()`, `populateTipiVisitaSelects()`, `addTipoVisita()`

### Step 4.8 — Pulizia e hardening
- [ ] Rimuovere `save()` / `load()` da localStorage dove non più necessario (o tenere come cache offline)
- [ ] Gestire conflitti di sync (es. appuntamento creato offline e poi sincronizzato)
- [ ] Loading states / skeleton UI durante le fetch DB
- [ ] Gestione errori user-facing (toast più descrittivi per errori Supabase)
- [ ] Rimuovere `console.log` di debug in produzione

### Sicurezza
- [ ] Verificare che le policy RLS coprano tutti i casi (es. medico non può leggere dati di altri medici)
- [ ] Rate limiting sulla policy anon INSERT appuntamenti (attualmente qualsiasi anon può inserire per qualsiasi `medico_id` valido — valutare RPC SECURITY DEFINER per l'insert pubblico)
- [ ] `config.js` mai committato (già in `.gitignore`) — documentare procedura onboarding per nuovi ambienti
- [ ] Scadenza sessione Supabase: gestire `onAuthStateChange` con refresh automatico

---

## Da fare in seguito

### Hosting e dominio
- [ ] Scegliere hosting statico (Netlify / Vercel / GitHub Pages / Cloudflare Pages)
- [ ] Dominio personalizzato (es. `medidesk.it` o sottodominio)
- [ ] HTTPS automatico (incluso in tutti i provider sopra)
- [ ] Separare ambiente dev / prod (Supabase project separati)

### Email e notifiche
- [ ] Email di conferma al paziente dopo prenotazione (Supabase Edge Function + Resend/SendGrid)
- [ ] Email di promemoria 24h prima dell'appuntamento (cron Supabase)
- [ ] Notifica push al medico per nuove prenotazioni online (Web Push API o email)

### Pagamenti (opzionale, lungo termine)
- [ ] Integrazione Stripe per pagamento anticipato al momento della prenotazione
- [ ] Gestione rimborsi e cancellazioni con policy configurabile dal medico
- [ ] Ricevuta fiscale / fattura (valutare integrazione con Fatture in Cloud o simili)

### Multi-device e PWA
- [ ] Manifest PWA (`manifest.json`) per installazione su mobile come app
- [ ] Service Worker per offline completo (cache asset + sync in background)
- [ ] Push notifications native su mobile

### Funzionalità future (backlog)
- [ ] Multi-medico / studio associato: un account può gestire più profili
- [ ] Calendario Google / iCal sync bidirezionale
- [ ] Import pazienti da CSV / Excel
- [ ] Statistiche avanzate (trend visite, revenue, pazienti nuovi vs ricorrenti)
- [ ] Template referti personalizzabili
- [ ] Firma digitale referti (PDF con firma)
- [ ] Ricerca full-text sullo storico clinico (già parzialmente implementata lato UI)
- [ ] App mobile nativa (React Native / Expo) — **ricerca futura**, non prioritaria finché la PWA regge

---

*Ultimo aggiornamento: 2026-05-13 — Migliorie: festività+ferie, pazienti per centro, condivisione PDF/email/share, fix centri eliminati, ordine tipi visita*
