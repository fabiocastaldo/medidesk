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

- [ ] **Email approvazione tardiva**: l'email al medico arriva solo dopo refresh della pagina admin. Sospetto: risposta HTML restituita prima che `fetch` a `send-email` completi in `approve-doctor.js`
- [ ] **Errori 406 al login**: query `medici?user_id=eq.xxx` ×5 al primo login post-approvazione — capire se solo rumore o rompe qualcosa
- [ ] **409 Conflict su `ensureMedicoRecord`**: innocuo (gestito da catch), ma sporca i log

---

## 🔜 Prossime priorità

### Merge e deploy
- [ ] Testare branch `feat-specializzazione-centri` su Vercel preview
- [ ] Merge `feat-specializzazione-centri` → `master` e push per deploy produzione

### Dominio
- [ ] Completare configurazione `delphi-med.it` su Vercel: CNAME `www` → `8d5de3516bd187e8.vercel-dns-017.com` su Cloudflare → Refresh Vercel

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
- [ ] Campo "altre specializzazioni" nel profilo (multi-select su `specializzazioni[]`)
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
- **Branch attivo**: `feat-specializzazione-centri` — da mergiare su master dopo test

---

*Ultimo aggiornamento: 2026-05-17 — Schema DB aggiornato (specializzazione + centri via/città/prov/CAP), bug auth risolti, rebrand Delphi~Med*
