// lib/email-shell.js
// Shell HTML condivisa per le email transazionali Delphi~Med.
// Vincoli email-client: niente var()/color-mix()/SVG/web-font; gradiente con
// fallback solido (background-color + bgcolor); tutto inline.

const C = {
  deep:   '#0B2B4D',
  mid:    '#15487F',
  bright: '#2F74C7',
  bodyBg: '#eef2f7',
  card:   '#ffffff',
  ink:    '#1a1a1a',
  ink2:   '#555555',
  ink3:   '#888888',
  faint:  '#bbbbbb',
  detailBg:     '#f1f6fd',
  detailBorder: '#d3e3f4',
  detailSep:    '#e2edf8',
  warnBg:   '#fffbeb',
  warnBar:  '#f59e0b',
  dangerBg: '#fef2f2',
  danger:   '#dc2626',
};

export function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatDateIt(dateStr) {
  try {
    return new Date(dateStr + 'T12:00:00')
      .toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } catch (_) { return dateStr || ''; }
}

export function emailShell(bodyHtml, { footerNote } = {}) {
  const foot = footerNote || 'Messaggio automatico da Delphi~Med &middot; Non rispondere a questa email';
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.bodyBg};font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${C.bodyBg};padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:${C.card};border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:560px;">
  <tr>
    <td bgcolor="${C.mid}" style="background-color:${C.mid};background-image:linear-gradient(135deg,${C.bright} 0%,${C.mid} 52%,${C.deep} 100%);padding:34px 40px;text-align:center;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:27px;font-weight:700;color:#ffffff;letter-spacing:.3px;line-height:1;">Delphi~Med</div>
      <div style="margin-top:7px;font-size:13px;color:rgba(255,255,255,.82);letter-spacing:.2px;">Il medico al tuo fianco</div>
    </td>
  </tr>
  <tr><td align="center" style="padding:36px 0;">
    <table width="480" cellpadding="0" cellspacing="0" style="width:480px;max-width:480px;">
      <tr><td>${bodyHtml}</td></tr>
    </table>
  </td></tr>
  <tr>
    <td style="background:#f7f9f9;border-top:1px solid #ececec;padding:18px 40px;text-align:center;">
      <p style="margin:0;font-size:11px;color:${C.faint};">${foot}</p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function emailTitle(text, { tone = 'brand', iconUrl } = {}) {
  const color = tone === 'danger' ? C.danger : C.mid;
  const icon = iconUrl
    ? `<img src="${iconUrl}" width="24" height="24" alt="" style="display:block;margin:0 0 10px;border:0;">`
    : '';
  return `${icon}<div style="width:40px;height:3px;background:${color};border-radius:2px;margin:0 0 14px;"></div>
<h1 style="margin:0 0 18px;font-size:20px;line-height:1.25;font-weight:700;color:${C.ink};">${text}</h1>`;
}

export function detailCard(rowsHtml) {
  // Tabella SINGOLA (come noteBox), niente tabella annidata: il client mobile riempie
  // le tabelle singole width:100% ma collassa quelle annidate al contenuto. Il padding
  // della card e' ora sulle celle delle righe (detailRow: 14px 24px).
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:${C.detailBg};border:1px solid ${C.detailBorder};border-radius:8px;margin-bottom:28px;">${rowsHtml}</table>`;
}

export function detailRow(label, value, { last = false } = {}) {
  const sep = last ? '' : `border-bottom:1px solid ${C.detailSep};`;
  return `<tr><td style="padding:14px 24px;${sep}">
    <span style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">${label}</span><br>
    <strong style="color:#111;font-size:14px;">${value}</strong>
  </td></tr>`;
}

export function noteBox(html, { tone = 'warn' } = {}) {
  const bg  = tone === 'danger' ? C.dangerBg : C.warnBg;
  const bar = tone === 'danger' ? C.danger   : C.warnBar;
  return `<table width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:${bg};border-left:3px solid ${bar};border-radius:0 6px 6px 0;margin:0 0 28px;">
  <tr><td style="padding:14px 18px;">
    <p style="margin:0;font-size:13px;color:${C.ink2};line-height:1.6;">${html}</p>
  </td></tr>
</table>`;
}

export function ctaButton(href, label) {
  return `<div style="text-align:center;margin:0 0 28px;">
    <a href="${href}" style="display:inline-block;padding:13px 28px;background:${C.mid};color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;">${label}</a>
  </div>`;
}
