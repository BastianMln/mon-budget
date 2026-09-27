// ─────────────────────────────────────────────────────────────────────────────
// Lecture des relevés bancaires (PDF ou CSV) et classement automatique.
// La partie « lecture de PDF » reçoit des morceaux de texte positionnés
// (fournis par pdf.js) : elle est testable sans navigateur.
// ─────────────────────────────────────────────────────────────────────────────
import { round2 } from './calc.js';

const pad = (n) => String(n).padStart(2, '0');
const AMOUNT_RE = /^-?\d{1,3}(?:[ .  ]\d{3})*,\d{2}$/;
const DATE_START_RE = /^(\d{2})[./](\d{2})(?:[./](\d{2}|\d{4}))?$/;

export function frAmount(s) {
  return round2(parseFloat(String(s).replace(/[ .  ]/g, '').replace(',', '.')));
}

const BANKS = [
  { id: 'lcl', name: 'LCL', test: /LCL|CREDIT LYONNAIS|CRÉDIT LYONNAIS/i },
  { id: 'lbp', name: 'La Banque Postale', test: /BANQUE POSTALE|LABANQUEPOSTALE/i },
  { id: 'bourso', name: 'Boursorama', test: /BOURSORAMA|BOURSOBANK/i },
];
export function detectBank(text) {
  return BANKS.find((b) => b.test.test(text)) || { id: 'autre', name: 'Banque' };
}

// ── PDF : regroupe les morceaux de texte en lignes ──────────────────────────
/** items : [{ str, x, y, w, page }] → lignes [{ page, y, cells:[{str,x,right}] }] triées de haut en bas */
export function toLines(items) {
  const lines = [];
  const sorted = items.filter((i) => i.str && i.str.trim())
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  for (const it of sorted) {
    let line = lines.find((l) => l.page === it.page && Math.abs(l.y - it.y) <= 2.5);
    if (!line) { line = { page: it.page, y: it.y, cells: [] }; lines.push(line); }
    line.cells.push({ str: it.str.trim(), x: it.x, right: it.x + (it.w || 0) });
  }
  for (const l of lines) l.cells.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => a.page - b.page || b.y - a.y);
}

/**
 * Lit un relevé mis en page en tableau « DATE · LIBELLÉ · (VALEUR) · DÉBIT · CRÉDIT »
 * (format de LCL, et de la plupart des relevés français).
 * Renvoie { bank, period:{from,to}, ops:[{date, bookDate, label, amount, direction}], closing, opening }
 */
export function parseStatementItems(items) {
  const lines = toLines(items);
  const text = lines.map((l) => l.cells.map((c) => c.str).join(' ')).join('\n');
  const bank = detectBank(text);

  // Période « du 01.08.2026 au 31.08.2026 »
  const pm = text.match(/du\s+(\d{2})[./](\d{2})[./](\d{4})\s+au\s+(\d{2})[./](\d{2})[./](\d{4})/i);
  const period = pm ? { from: `${pm[3]}-${pm[2]}-${pm[1]}`, to: `${pm[6]}-${pm[5]}-${pm[4]}` } : null;
  const endYear = period ? Number(period.to.slice(0, 4)) : new Date().getFullYear();
  const endMonth = period ? Number(period.to.slice(5, 7)) : 12;
  const yearFor = (m) => (m > endMonth ? endYear - 1 : endYear);

  const ops = [];
  let cols = null;                       // { debit, credit } : bord droit des en-têtes, par page
  let current = null;
  let opening = null;
  let closing = null;

  for (const line of lines) {
    const joined = line.cells.map((c) => c.str).join(' ');
    const upper = joined.toUpperCase();
    const hDebit = line.cells.find((c) => /^D[ÉE]BIT/i.test(c.str));
    const hCredit = line.cells.find((c) => /^CR[ÉE]DIT/i.test(c.str));
    if (hDebit && hCredit && /DATE/i.test(joined)) {
      cols = { page: line.page, debit: hDebit.right, credit: hCredit.right };
      current = null;
      continue;
    }
    if (!cols || cols.page !== line.page) { current = null; continue; }

    const amounts = line.cells.filter((c) => AMOUNT_RE.test(c.str)
      && Math.min(Math.abs(c.right - cols.debit), Math.abs(c.right - cols.credit)) < 45);
    const side = (c) => (Math.abs(c.right - cols.debit) <= Math.abs(c.right - cols.credit) ? 'debit' : 'credit');

    if (/ANCIEN SOLDE|SOLDE PR[ÉE]C[ÉE]DENT|SOLDE AU \d/.test(upper) && amounts.length) {
      const a = amounts.at(-1);
      opening = side(a) === 'credit' ? frAmount(a.str) : -frAmount(a.str);
      current = null;
      continue;
    }
    if (/SOLDE EN EUROS|NOUVEAU SOLDE|SOLDE CR[ÉE]DITEUR|SOLDE D[ÉE]BITEUR|SOLDE FINAL/.test(upper) && amounts.length) {
      const a = amounts.at(-1);
      closing = side(a) === 'credit' ? frAmount(a.str) : -frAmount(a.str);
      if (/D[ÉE]BITEUR/.test(upper)) closing = -Math.abs(closing);
      current = null;
      continue;
    }
    if (/^TOTAU?X|TOTAL DES OP/.test(upper.trim())) { current = null; continue; }

    const first = line.cells[0];
    const dm = first && first.str.match(DATE_START_RE);
    if (dm && amounts.length) {
      const amountCell = amounts.at(-1);
      const labelCells = line.cells.slice(1).filter((c) => c !== amountCell && !AMOUNT_RE.test(c.str)
        && !DATE_START_RE.test(c.str) && c.str !== '.');
      const m = Number(dm[2]);
      const y = dm[3] ? (dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3])) : yearFor(m);
      current = {
        bookDate: `${y}-${pad(m)}-${dm[1]}`,
        label: labelCells.map((c) => c.str).join(' ').replace(/\s+/g, ' ').trim(),
        amount: frAmount(amountCell.str),
        direction: side(amountCell),
        extra: [],
      };
      ops.push(current);
      continue;
    }
    // Ligne de suite (ville, référence…) : complète l'opération précédente
    if (current && !dm && !amounts.length && first && first.x > 30 && first.x < 300) {
      const s = joined.trim();
      if (s && !/^(REF\.?CLIENT|LIBELLE:NOTPROVID|NATURE DU PAIEMENT|ID\.?CREANCIER|REF\.?MANDAT|Page \d)/i.test(s)
        && !/^[A-Z0-9]{12,}$/.test(s) && s.length < 60) current.extra.push(s);
    } else if (!dm) {
      current = null;
    }
  }

  for (const op of ops) {
    op.date = purchaseDate(op.label, op.bookDate) || op.bookDate;
    op.detail = op.extra.join(' ');
    delete op.extra;
  }
  return { bank, period, ops, opening, closing };
}

/** « CB PAIN SAS 7EPIS 06/08/26 » → date d'achat 2026-08-06 (plus juste que la date de passage). */
export function purchaseDate(label, bookDate) {
  const m = label.match(/(\d{2})\/(\d{2})(?:\/(\d{2,4}))?\s*$/) || label.match(/\bDU (\d{2})\/(\d{2})(?:\/(\d{2,4}))?/i)
    || label.match(/^\s*(?:CARTE|CB|PAIEMENT CB)\s+(\d{2})\/(\d{2})\/(\d{2,4})\b/i);
  if (!m) return null;
  const by = Number(bookDate.slice(0, 4));
  const bm = Number(bookDate.slice(5, 7));
  let y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : by;
  if (!m[3] && Number(m[2]) > bm) y = by - 1;
  const d = `${y}-${m[2]}-${m[1]}`;
  return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(d) ? d : null;
}

// ── CSV (export d'opérations) ───────────────────────────────────────────────
export function parseCsv(text) {
  const clean = text.replace(/^﻿/, '');
  const sample = clean.split(/\r?\n/).slice(0, 20).join('\n');
  const sep = [';', '\t', ','].sort((a, b) => sample.split(b).length - sample.split(a).length)[0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c));
}

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Transforme un CSV bancaire en opérations, en devinant les colonnes. */
export function parseCsvStatement(text) {
  const rows = parseCsv(text);
  const bank = detectBank(text);
  const hi = rows.findIndex((r) => r.some((c) => /date/i.test(c)) && r.some((c) => /(libell|label|op[ée]ration|montant|amount|d[ée]bit)/i.test(c)));
  if (hi < 0) throw new Error('Colonnes introuvables dans ce fichier CSV.');
  const head = rows[hi].map(norm);
  const find = (...res) => head.findIndex((h) => res.some((re) => re.test(h)));
  const iDate = find(/^date ?op/, /^dateop/, /^date$/, /date/);
  const iLabel = find(/libelle/, /^label$/, /operation/, /description/);
  const iDetail = find(/detail/, /complement/, /information/);
  const iAmount = find(/^montant/, /^amount/);
  const iDebit = find(/debit/);
  const iCredit = find(/credit/);
  const iBalance = find(/solde/, /balance/);
  const ops = [];
  let closing = null;
  for (const r of rows.slice(hi + 1)) {
    const ds = r[iDate] || '';
    const dm = ds.match(/^(\d{2})[/.-](\d{2})[/.-](\d{2,4})$/) || ds.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!dm) continue;
    const date = dm[1].length === 4 ? `${dm[1]}-${dm[2]}-${dm[3]}` : `${dm[3].length === 2 ? `20${dm[3]}` : dm[3]}-${dm[2]}-${dm[1]}`;
    let value;
    if (iAmount >= 0 && r[iAmount]) value = parseFloat(r[iAmount].replace(/[\s  €]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    else {
      const d = iDebit >= 0 && r[iDebit] ? Math.abs(parseFloat(r[iDebit].replace(/[\s  €]/g, '').replace(',', '.'))) : 0;
      const c = iCredit >= 0 && r[iCredit] ? Math.abs(parseFloat(r[iCredit].replace(/[\s  €]/g, '').replace(',', '.'))) : 0;
      value = c - d;
    }
    if (!Number.isFinite(value) || value === 0) continue;
    const label = (r[iLabel] || '').replace(/\s+/g, ' ').trim();
    ops.push({
      bookDate: date,
      date: purchaseDate(label, date) || date,
      label,
      detail: iDetail >= 0 ? r[iDetail] || '' : '',
      amount: round2(Math.abs(value)),
      direction: value < 0 ? 'debit' : 'credit',
    });
    if (iBalance >= 0 && r[iBalance] && closing === null) {
      const b = parseFloat(r[iBalance].replace(/[\s  €]/g, '').replace(',', '.'));
      if (Number.isFinite(b)) closing = round2(b);
    }
  }
  const dates = ops.map((o) => o.bookDate).sort();
  return { bank, period: dates.length ? { from: dates[0], to: dates.at(-1) } : null, ops, opening: null, closing };
}

// ── Classement ───────────────────────────────────────────────────────────────
/** « CB PAIN SAS 7EPIS 06/08/26 » → « PAIN SAS 7EPIS » ; « ECHEANCE PRET PERSONNEL 140826 » → « ECHEANCE PRET PERSONNEL » */
export function merchantOf(label) {
  let s = ` ${label.toUpperCase()} `;
  s = s.replace(/^\s*(CB|CARTE|PAIEMENT CB|ACHAT CB|PAIEMENT PAR CARTE|PRLV SEPA|PRELEVEMENT|PRLV|VIR SEPA|VIR INST|VIREMENT( INSTANTANE)?( SEPA)?( RECU| EMIS)?( DE| A| VERS)?)\s+/, ' ');
  s = s.replace(/^\s*\d{2}\/\d{2}\/\d{2,4}\s+/, ' ').replace(/\s\d{2}\/\d{2}(\/\d{2,4})?\s*$/, ' ').replace(/\sDU \d{2}\/\d{2}(\/\d{2,4})?/, ' ');
  s = s.replace(/\sP\/\s*$/, ' ').replace(/\sDU\s*$/, ' ').replace(/(\s\d{4,})+\s*$/, ' ').replace(/\*/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

export const ruleKey = (merchant) => norm(merchant).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

// Commerçants courants → nom de catégorie (cherché parmi les catégories de la personne)
const BUILTIN = [
  ['Péage + essence', /\b(ESCOTA|ASF|APRR|SANEF|AREA|COFIROUTE|VINCI AUTOROUTES?|SMTPC|TUNNEL|PEAGE|TOTAL ?ENERGIES|TOTAL ACCESS|ESSO|SHELL|AVIA|STATION|CARBURANT|BP)\b/],
  ['Courses', /\b(CARREFOUR|LECLERC|AUCHAN|LIDL|ALDI|MONOPRIX|FRANPRIX|CASINO|INTERMARCHE|SUPER U|HYPER U|U EXPRESS|SPAR|PICARD|GRAND FRAIS|NETTO|COCCINELLE|BIOCOOP|NATURALIA|PROXI|VIVAL|G20|BOULANG\w*|PAIN)\b/],
  ['Bar / resto', /\b(BAR|CAFE|BRASSERIE|RESTAU\w*|PIZZ\w*|BURGER\w*|KEBAB|SUSHI|MCDO\w*|MC DONALD\w*|KFC|UBER ?EATS|DELIVEROO|BISTRO\w*|PUB|FIZZ|BRUNCH|TRAITEUR)\b/],
  ['Transport', /\b(SNCF|OUIGO|TGV|RTM|RATP|LIME|BOLT|UBER|BLABLACAR|EFFIA|INDIGO|PARKING|NAVIGO|TRANSAVIA|EASYJET|RYANAIR|AIR FRANCE|VOLOTEA)\b/],
  ['Santé', /\b(PHARMACIE|PHARMA\w*|MEDECIN|DOCTEUR|DR|LABORATOIRE|LABO|OPTIC\w*|DENTISTE|KINE\w*|HOPITAL|CLINIQUE|RADIOLOGIE)\b/],
  ['Abonnements', /\b(APPLE\.?COM|NETFLIX|SPOTIFY|DEEZER|CANAL|PRIME VIDEO|AMAZON PRIME|DISNEY|ANTHROPIC|CLAUDE\.?AI|FREE MOBILE|SFR|ORANGE|BOUYGUES|SOSH|RED BY SFR|ICLOUD|GOOGLE ?ONE|YOUTUBE)\b/],
  ['Sport', /\b(DECATHLON|BASIC ?FIT|FITNESS|GO SPORT|INTERSPORT|ON AIR|KEEP COOL|CLIMB\w*|ESCALADE|PISCINE)\b/],
  ['Vêtements', /\b(ZARA|H ?& ?M|UNIQLO|KIABI|CELIO|JULES|NIKE|ADIDAS|BERSHKA|PULL ?& ?BEAR|VINTED|LA HALLE|PRIMARK|SNIPES|COURIR|JD SPORTS|GALERIES LAFAYETTE|PRINTEMPS)\b/],
  ['Coiffeur', /\b(COIFF\w*|BARBER\w*|SALON DE COIFFURE)\b/],
  ['Loisirs', /\b(FDJ|SHOTGUN|CINEMA|PATHE|UGC|GAUMONT|FNAC|CULTURA|TICKETMASTER|BILLETTERIE|ARENES|HOTEL|AIRBNB|BOOKING|MUSEE|STEAM|PLAYSTATION|NINTENDO|BOWLING|KARTING|LASER)\b/],
];

/**
 * Classe une opération importée.
 * ctx : { categories, rules (merchant_rules), ownerNames: ['DUPONT ALEX', …], defaultIncome }
 * → { kind: 'depense'|'revenu'|'ignore'|'salaire', category_id, reimbursable, reason, merchant, key }
 */
export function classify(op, ctx) {
  const merchant = merchantOf(op.label);
  const key = ruleKey(merchant);
  const label = op.label.toUpperCase();
  const names = (ctx.ownerNames || []).map((n) => norm(n)).filter((n) => n.length >= 5);
  const hay = norm(`${op.label} ${op.detail || ''}`);
  const isTransfer = /\b(VIR|VIREMENT)\b/.test(label);
  const catByName = (name) => ctx.categories.find((c) => !c.archived && norm(c.name) === norm(name));
  const base = { merchant, key, category_id: null, reimbursable: false };

  // 1. Virements entre ses propres comptes
  if (isTransfer && names.some((n) => hay.includes(n) || hay.includes(n.split(' ').reverse().join(' ')))) {
    return { ...base, kind: 'ignore', reason: 'Virement entre tes comptes' };
  }
  // 2. Règle apprise (ou réglée par la personne)
  const rule = (ctx.rules || []).find((r) => r.merchant === key);
  if (rule) {
    if (rule.action === 'ignorer') return { ...base, kind: 'ignore', reason: 'Toujours ignoré (ta règle)' };
    if (rule.action === 'rembourse') return { ...base, kind: 'depense', reimbursable: true, category_id: rule.category_id || null, reason: 'Remboursement attendu (ta règle)' };
    if (op.direction === 'debit' && ctx.categories.some((c) => c.id === rule.category_id)) {
      return { ...base, kind: 'depense', category_id: rule.category_id, reason: 'Commerçant connu' };
    }
  }
  // 3. Rentrées d'argent
  if (op.direction === 'credit') {
    const salaryWords = /\b(SALAIRE|PAIE|REMUNERATION|TRAITEMENT|PAYE)\b/.test(label);
    const big = ctx.defaultIncome > 0 && op.amount >= ctx.defaultIncome * 0.5;
    if (salaryWords || (big && isTransfer)) return { ...base, kind: 'salaire', reason: 'Salaire' };
    return { ...base, kind: 'revenu', reason: 'Rentrée d’argent' };
  }
  // 4. Commerçants courants
  for (const [name, re] of BUILTIN) {
    if (re.test(` ${merchant} `)) {
      const c = catByName(name);
      if (c) return { ...base, kind: 'depense', category_id: c.id, reason: 'Reconnu automatiquement' };
    }
  }
  return { ...base, kind: 'depense', reason: isTransfer || /LYDIA|PAYPAL|WERO|PAYLIB/.test(label) ? 'Envoi à une personne' : 'À classer' };
}

/** Identifiant stable d'une opération (évite de l'importer deux fois). */
export function externalIds(bankId, ops) {
  const seen = new Map();
  return ops.map((o) => {
    const base = `${bankId}|${o.bookDate}|${o.direction === 'debit' ? '-' : '+'}${o.amount.toFixed(2)}|${ruleKey(o.label)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return `${base}|${n}`.slice(0, 200);
  });
}

/** Dépense déjà présente (ajoutée par Apple Pay ou à la main) : même montant, ±3 jours. */
export function findDuplicate(op, transactions, used = new Set()) {
  if (op.direction !== 'debit') return null;
  const t0 = Date.parse(op.date);
  return transactions.find((t) => !used.has(t.id) && !t.external_id && (t.source === 'raccourci' || t.source === 'manuel')
    && Math.abs(Number(t.amount) - op.amount) < 0.005
    && Math.abs(Date.parse(t.date) - t0) <= 3 * 86400000) || null;
}

/** Charge pdf.js à la demande (1,8 Mo : seulement quand on importe un PDF). */
export async function readPdfItems(file) {
  const pdfjs = await import('./pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const items = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      if (!it.str) continue;
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, page: p });
    }
  }
  return items;
}

export async function readStatement(file) {
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  if (isPdf) {
    const res = parseStatementItems(await readPdfItems(file));
    if (!res.ops.length) throw new Error('Aucune opération trouvée dans ce PDF. Envoie-le à l’assistant pour qu’il ajoute ce format.');
    return res;
  }
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
  return parseCsvStatement(text);
}
