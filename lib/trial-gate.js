// lib/trial-gate.js
// Hard-gate Free Trial (45gg), verità lato server.
// Solo piano='free' scade; founding/pro/vip non scadono mai.
// Fail-open su created_at assente/malformato: un glitch NON deve bloccare l'accesso.
const TRIAL_DAYS = 45;

export function trialExpired(piano, createdAt) {
  if (piano !== 'free') return false;
  if (!createdAt) return false;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return false;
  const scad = new Date(created.getTime());
  scad.setUTCDate(scad.getUTCDate() + TRIAL_DAYS);
  return Date.now() > scad.getTime();
}
