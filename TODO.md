# Delphi~Med — Roadmap & TODO

## Decisioni di design

### Filosofia del prodotto
- **Strumento del medico, non marketplace.** Delphi~Med è un'agenda digitale personale per il medico specialista libero professionista: gestisce appuntamenti, pazienti e studio in più ambulatori. Non è una piattaforma pubblica di ricerca medici.
- **No recensioni pubbliche.** Il profilo del medico esiste per la pagina di prenotazione condivisa direttamente ai pazienti (link/WhatsApp/QR). La home pubblica ha una barra di ricerca per nome/specializzazione, ma l'acquisizione parte sempre dal medico.
- **Single-file HTML.** Nessun build system, nessun framework: tutto in `medidesk.html` per massima portabilità e semplicità di deployment.
- **Offline-first con sync Supabase.** Lo stato vive in `localStorage` (`medidesk_v2`) e viene sincronizzato su Supabase quando online.
- **Pricing futuro**: ~19-29€/mese.

### Scelte tecniche principali
- **Supabase EU (Frankfurt)** per auth, DB PostgreSQL e storage foto.
- **RLS** su tutte le tabelle; funzioni SECURITY DEFINER per operazioni anon (prenotazione, ricerca pubblica, slug).
- **UUID** come chiave primaria; comparazioni sempre via `String(a)===String(b)`.
- **Slug univoco** generato automaticamente dal trigger `medici_auto_slug()` con cascata: nome-cognome → +spec → +provincia → +albo → fallback random 3 char.
- **Deploy**: solo `git push origin master` → Vercel rileva e pubblica automaticamente. NON usare `npx vercel --prod`.

---

## ✅ Completato — sessione 2026-05-17 (notte)

### Profilo medico — Altre specializzazioni
- [x] Costante `SPECIALIZZAZIONI_UFFICIALI` (53 voci) estratta dal form di registrazione; usata sia da `#reg-specializzazione` che dal profilo
- [x] `#setting-spec` (specializzazione principale) convertita da input libero a `<select>` a 53 voci
- [x] Nuovo campo "Altre specializzazioni" nel profilo: area chip `#spec-altre-list` + tendina `#setting-spec-altre-select`
- [x] `renderSpecAltre()`: ridisegna chip ed esclude dalla tendina le voci già usate (principale + altre)
- [x] `addSpecAltra()` / `removeSpecAltra()`: aggiunge/rimuove chip con aggiornamento tendina
- [x] `onSpecPrincChange()`: se la nuova principale era già tra le altre, la rimuove con toast
- [x] `loadSettings()`: popola `specAltre` da `data.specializzazioni` (esclude la principale)
- [x] `saveSettings()`: scrive `specializzazioni: [...new Set([spec, ...specAltre])]` deduplicato su Supabase

### Centri — Modifica centro
- [x] Bottone ✏️ aggiunto a ogni card centro (sia attivi che disattivati), a sinistra di ⏸/▶
- [x] `openEditCentro(id)`: popola la modale con i dati del centro e cambia titolo/bottone in "Modifica / Salva modifiche"
- [x] `openAddCentro()`: resetta il form e ripristina "Aggiungi centro / Salva centro"
- [x] `closeCentroModal()`: azzera `_centroEditId` — usato da ×, Annulla e dopo il salvataggio
- [x] `saveCentro()`: gestisce INSERT (nuovo) e UPDATE (modifica) preservando turni, giornate singole e stato attivo
- [x] `resetCentroForm()`: utility estratta per il reset del form centro

---

## ✅ Completato — sessione 2026-05-17 (sera)

### Merge e deploy
- [x] Merge `feat-specializzazione-centri` → `master` (fast-forward, 3 commit) e push su origin; branch eliminato in locale e remote
- [x] Step 5 prenotazione (`bk-step-5`): bottone "Prenota un altro appuntamento" → link "Torna alla home" che reindirizza a https://delphi-med.com

### Dominio
- [x] `delphi-med.it` configurato e funzionante: record A `@` → `76.76.21.21` + CNAME `www` → `8d5de3516bd187e8.vercel-dns-017.com` su Cloudflare (Proxy: DNS only)

### Bug risolti
- [x] Email approvazione tardiva: l'email al medico ora arriva senza necessità di refresh
- [x] Errori 406 al login post-approvazione risolti
- [x] 409 Conflict su `ensureMedicoRecord` risolto

---

## ✅ Completato — sessione 2026-05-17 (schema DB + frontend)

### Wipe e migrazione schema DB
- [x] Wipe totale dati eseguito (tabelle svuotate, si riparte da zero)
- [x] `centri`: rimosso campo `indirizzo`, aggiunti `via`, `citta`, `provincia`, `cap`
- [x] `medici`: aggiunti `specializzazione` (TEXT), `specializzazioni` (TEXT[]), `slug`
- [x] Funzione SQL `generate_unique_slug()` con cascata estesa (SECURITY DEFINER)
- [x] Trigger `medici_auto_slug()` BEFORE INSERT/UPDATE: genera slug e mantiene `specializzazioni[]` coerente
- [x] Funzione `search_medici_pubblici(p_query)`: cerca su nome/cognome/specializzazione/specializzazioni[], ritorna citta[]
- [x] View `medici_pubblici`: filtra stato='approvato' AND slug IS NOT NULL AND specializzazione IS NOT NULL
- [x] `add-medici-approval.sql` eseguito (campi approvazione, stato default 'approvato' per account legacy) ✅

### Bug risolti
- [x] Flash dashboard durante registrazione → flag `_isRegistering` + guard in `onAuthStateChange`
- [x] Box "Registrazione inviata!" non appariva → gestione deterministica SIGNED_OUT post-signUp
- [x] Capitalize automatico nome/cognome → `onblur` inline sugli input HTML
- [x] Rebrand completo "Delphi Med" → "Delphi~Med" ovunque (HTML + email admin + email approvazione)
- [x] Bug ricerca medici non visibili: trigger slug bloccato da RLS → fix SECURITY DEFINER
- [x] Bug omonimia (es. "Mario Rossi"): cascata slug nome-cognome → +spec → +provincia → +albo

### Branch `feat-specializzazione-centri` (commit `fb125aa`, da mergiare su master)
- [x] Form registrazione: tendina "Specializzazione" obbligatoria (53 voci ufficiali italiane)
- [x] `signUp()`: lettura, validazione e INSERT di `specializzazione` in tabella `medici`
- [x] Modale "Aggiungi centro": 4 campi separati via/città/provincia (110 sigle)/CAP al posto di "indirizzo"
- [x] `saveCentro()`: INSERT con nuovi campi separati + indirizzo composto per retrocompatibilità locale
- [x] `loadCentriFromDB()`: mappa via/citta/provincia/cap dal DB, compone stringa indirizzo
- [x] `homeSearch()`: mostra specializzazione(i) + città dei centri (max 2 + contatore)
- [x] `saveSettings()`: `confirm()` esplicito se nome/cognome/specializzazione cambiano (impatto slug)
- [x] Auto-capitalize `onblur` su nome centro e via nella modale centro

---

## ✅ Completato — sessione 2026-05-16 (onboarding medici)

### Registrazione medico con approvazione manuale
- [x] Form registrazione con campi obbligatori: nome, cognome, CF, n° ordine, provincia ordine
- [x] Validazione password forte: 8+ caratteri, maiuscola, minuscola, numero, carattere speciale — indicatore visivo in tempo reale
- [x] `supabase.auth.signOut()` dopo `signUp()` per bloccare il login automatico
- [x] INSERT in `medici` con tutti i campi + `stato: 'in_attesa'`; tipi visita default creati contestualmente
- [x] Email di notifica all'admin con dati medico e link di approvazione
- [x] Endpoint `api/approve-doctor.js`: PATCH `stato = 'approvato'` + invio email di benvenuto al medico
- [x] Blocco login per medici con `stato = 'in_attesa'`
- [x] Messaggio post-registrazione inline (success box) con pulsante "Torna alla home"
- [x] Link a Termini di servizio e Privacy policy nel form

### Infrastruttura email
- [x] Dominio `delphi-med.com` verificato su Resend
- [x] Mittente: `noreply@delphi-med.com`
- [x] `api/send-email.js` con modalità generica `{to, subject, html}`
- [x] `SUPABASE_SERVICE_ROLE_KEY` configurata in Vercel

---

## ⚠️ Problemi aperti (noti, non ancora risolti)

*(nessun problema aperto noto al momento)*

---

## 🔜 Prossime priorità

### Contenuti legali
- [ ] Sostituire placeholder `termini-di-servizio.html` con testo reale
- [ ] Sostituire placeholder `privacy-policy.html` con testo reale

### Email e notifiche (Step 7)
- [ ] **Step 7b** — notifica email al centro quando arriva una prenotazione
- [ ] **Step 7c** — promemoria 24h al paziente (Vercel Cron Jobs)
- [ ] **Step 7d** — notifiche al medico (3 toggle già in profilo)

### Step 4.8 — Pulizia e hardening
- [ ] Rimuovere `save()` / `load()` da localStorage dove non più necessario
- [ ] Loading states / skeleton UI durante le fetch DB
- [ ] Toast errori Supabase più descrittivi
- [ ] Rimuovere `console.log` di debug in produzione

### Sicurezza
- [ ] Verificare copertura RLS completa (medico non legge dati di altri medici)
- [ ] Rate limiting sulla policy anon INSERT appuntamenti
- [ ] Scadenza sessione Supabase: gestire refresh automatico

---

## 📅 Da fare in seguito

### Prodotto
- [ ] Logo grafico Delphi~Med
- [ ] **Step 8** — indirizzo email personale medico + agente AI che legge mail centri
- [ ] **Step 9** — pagamenti Stripe (abbonamenti mensili ~19-29€/mese)
- [ ] **Step 10** — PWA + Capacitor per app store iOS/Android

### Pagamenti (lungo termine)
- [ ] Stripe: pagamento anticipato alla prenotazione, rimborsi, policy cancellazione
- [ ] Ricevuta fiscale / fattura (valutare Fatture in Cloud)

### Multi-device e PWA
- [ ] Manifest PWA per installazione mobile
- [ ] Service Worker per offline completo
- [ ] Push notifications native

### Funzionalità backlog
- [ ] Multi-medico / studio associato
- [ ] Calendario Google / iCal sync
- [ ] Import pazienti da CSV
- [ ] Statistiche avanzate (trend, revenue, pazienti nuovi vs ricorrenti)
- [ ] Template referti personalizzabili
- [ ] Firma digitale referti PDF

---

## ⚠️ Note operative

- **Confirm email DISATTIVATO** su Supabase: `signOut()` dopo `signUp()` compensa il login automatico
- **`SUPABASE_SERVICE_ROLE_KEY`** richiesta in Vercel per `approve-doctor.js` (bypass RLS)
- **Deploy**: solo `git push origin master` — NON `npx vercel --prod`
- **`config.js`** mai committato (in `.gitignore`)
- **Branch attivo**: nessuno — tutto su `master`

---

*Ultimo aggiornamento: 2026-05-17 notte — "Altre specializzazioni" multi-select nel profilo, modifica centro con modale in doppia modalità (crea/aggiorna)*
