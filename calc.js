// ─────────────────────────────────────────────────────────────────────────────
// Logique pure de l'application : aucun accès au DOM ni au réseau.
// Tout est testé dans calc.test.js.
// ─────────────────────────────────────────────────────────────────────────────

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const euroFmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
export const euros = (n) => euroFmt.format(round2(n || 0));

const pctFmt = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 });
export const percent = (ratio) => pctFmt.format(ratio || 0);

/**
 * Lit un montant saisi ou envoyé par l'iPhone : « 12,50 € », « €12.50 », « 1 234,56 », « -8 ».
 * Renvoie un nombre positif arrondi au centime, ou null si illisible.
 * Même logique que add_from_shortcut() côté base.
 */
export function parseAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? round2(Math.abs(raw)) : null;
  if (raw == null) return null;
  let s = String(raw).replace(/[^0-9,.]/g, '').replace(/,/g, '.');
  s = s.replace(/\.(?=.*\.)/g, '');
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  const n = round2(parseFloat(s));
  return Number.isFinite(n) ? n : null;
}

// ── Mois ─────────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');

export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

/** Nombre de mois de a à b inclus (« 2026-10 » → « 2027-05 » = 8). 0 si b < a. */
export function monthsBetween(a, b) {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return Math.max(0, (yb * 12 + mb) - (ya * 12 + ma) + 1);
}

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
  'août', 'septembre', 'octobre', 'novembre', 'décembre'];

const ABBR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

export function monthLabel(key, { short = false } = {}) {
  const [y, m] = key.split('-').map(Number);
  return short ? `${ABBR[m - 1]} ${y}` : `${MOIS[m - 1]} ${y}`;
}

export function dayLabel(dk) {
  const [, m, d] = dk.split('-').map(Number);
  return `${d} ${ABBR[m - 1]}`;
}

// ── Mois de budget : d'une paie à la suivante ────────────────────────────────
export const daysInMonth = (y, m) => new Date(y, m, 0).getDate();

export function addDays(dk, n) {
  const d = new Date(`${dk}T12:00:00`);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 86400000);

/**
 * Début par défaut du mois de budget « AAAA-MM ».
 * Paie entre le 1er et le 14 : elle tombe dans le mois lui-même.
 * Paie entre le 15 et le 31 : c'est la paie de fin de mois précédent qui finance ce mois
 * (salaire du 26 août → budget de septembre, du 26 août au 25 septembre).
 */
export function defaultPeriodStart(key, payDay = 1) {
  const pd = Math.min(31, Math.max(1, Number(payDay) || 1));
  const target = pd >= 15 ? addMonths(key, -1) : key;
  const [y, m] = target.split('-').map(Number);
  return `${target}-${pad(Math.min(pd, daysInMonth(y, m)))}`;
}

export function periodStart(key, months = [], payDay = 1) {
  return months.find((r) => r.month === key)?.start_date || defaultPeriodStart(key, payDay);
}

export function periodRange(key, months = [], payDay = 1) {
  return { start: periodStart(key, months, payDay), end: addDays(periodStart(addMonths(key, 1), months, payDay), -1) };
}

/** Mois de budget auquel appartient une date. */
export function periodOf(dk, months = [], payDay = 1) {
  const k = dk.slice(0, 7);
  for (const c of [k, addMonths(k, 1), addMonths(k, -1), addMonths(k, 2)]) {
    const { start, end } = periodRange(c, months, payDay);
    if (dk >= start && dk <= end) return c;
  }
  return k;
}

export function rangeLabel({ start, end }) {
  return `du ${dayLabel(start)} au ${dayLabel(end)}`;
}

/**
 * « Salaire reçu » : quel mois de budget démarre ?
 * Le mois en cours si sa paie n'a pas encore été confirmée et qu'il vient de commencer,
 * sinon le suivant (qui démarre alors aujourd'hui).
 */
export function salaryTarget(today, months = [], payDay = 1) {
  const cur = periodOf(today, months, payDay);
  const row = months.find((r) => r.month === cur);
  const { start } = periodRange(cur, months, payDay);
  if (!(row && row.income !== null && row.income !== undefined) && dayDiff(start, today) <= 10) return cur;
  return addMonths(cur, 1);
}

/** Salaire trouvé dans un relevé : mois de budget dont la paie prévue est la plus proche (±12 jours). */
export function periodForSalary(dk, payDay = 1) {
  const k = dk.slice(0, 7);
  let best = null;
  for (const c of [addMonths(k, -1), k, addMonths(k, 1), addMonths(k, 2)]) {
    const d = Math.abs(dayDiff(defaultPeriodStart(c, payDay), dk));
    if (d <= 12 && (!best || d < best.d)) best = { c, d };
  }
  return best?.c || null;
}

// ── Synthèse d'un mois de budget ────────────────────────────────────────────
/**
 * Budget restant = revenus − objectif d'épargne − dépenses déjà faites
 *                  − charges fixes pas encore passées (loyer, abonnements…).
 * C'est ce qu'on peut encore dépenser sans toucher à l'épargne des projets.
 *
 * Particularités :
 *  • une dépense lissée sur N mois compte pour 1/N dans chacun des N mois ;
 *  • une dépense « à rembourser » ne compte pas ; quand elle est remboursée, l'argent va
 *    soit dans le budget du mois (revenu), soit directement en épargne ;
 *  • kind « ignore » (virements entre ses comptes) et « revenu » ne sont pas des dépenses.
 */
export function summarizePeriod({ key, today, categories, transactions, months = [], settings = {}, goalMonthly = 0 }) {
  const payDay = settings?.pay_day || 1;
  const range = periodRange(key, months, payDay);
  const closed = range.end < today;
  const current = range.start <= today && today <= range.end;
  const row = months.find((r) => r.month === key);
  const salaryConfirmed = !!row && row.income !== null && row.income !== undefined;

  const cache = new Map();
  const pOf = (dk) => { if (!cache.has(dk)) cache.set(dk, periodOf(dk, months, payDay)); return cache.get(dk); };

  const known = new Set(categories.map((c) => c.id));
  const byCat = new Map();
  const unclassified = [];
  const revenues = [];
  let refundsToBudget = 0;
  let refundsToSavings = 0;
  let ignored = 0;

  for (const t of transactions) {
    if (!t.date) continue;
    const kind = t.kind || 'depense';
    const inRange = t.date >= range.start && t.date <= range.end;
    if (t.reimbursable) {
      if (t.reimbursed_at && t.reimbursed_at >= range.start && t.reimbursed_at <= range.end) {
        if (t.reimbursed_to === 'budget') refundsToBudget += Number(t.amount); else refundsToSavings += Number(t.amount);
      }
      continue;
    }
    if (kind === 'ignore') { if (inRange) ignored++; continue; }
    if (kind === 'revenu') { if (inRange) revenues.push(t); continue; }
    const n = Math.max(1, Number(t.spread_months || 1));
    let share = Number(t.amount);
    let part = null;
    if (n > 1) {
      const origin = pOf(t.date);
      const offset = key >= origin ? monthsBetween(origin, key) - 1 : -1;
      if (offset < 0 || offset >= n) continue;
      share = round2(Number(t.amount) / n);
      part = `${offset + 1}/${n}`;
    } else if (!inRange) continue;
    const entry = { ...t, share, part };
    if (t.category_id && known.has(t.category_id)) {
      if (!byCat.has(t.category_id)) byCat.set(t.category_id, []);
      byCat.get(t.category_id).push(entry);
    } else unclassified.push(entry);
  }

  const order = (a, b) => (b.date + (b.created_at || '')).localeCompare(a.date + (a.created_at || ''));
  const sum = (list, f = 'share') => round2(list.reduce((s, t) => s + Number(t[f] || 0), 0));
  const fixedKind = (c) => c.kind === 'fixe' || c.kind === 'epargne';

  const rows = [...categories]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .filter((c) => !c.archived || byCat.has(c.id))
    .map((c) => {
      const tx = (byCat.get(c.id) || []).sort(order);
      const spent = sum(tx);
      const budget = round2(Number(c.budget || 0));
      const pending = !closed && fixedKind(c) ? Math.max(0, round2(budget - spent)) : 0;
      return { category: c, budget, spent, remaining: round2(budget - spent), pending, tx, over: budget > 0 && spent > budget };
    });

  unclassified.sort(order);
  revenues.sort(order);
  const baseIncome = salaryConfirmed ? Number(row.income) : Number(settings?.default_income || 0);
  const income = round2(baseIncome + sum(revenues, 'amount') + refundsToBudget);
  const totalSpent = round2(rows.reduce((s, r) => s + r.spent, 0) + sum(unclassified));
  const fixedPending = round2(rows.reduce((s, r) => s + r.pending, 0));
  const remaining = round2(income - goalMonthly - totalSpent - fixedPending);
  const savings = round2(income - totalSpent - fixedPending + refundsToSavings);
  const group = (fixed) => rows.filter((r) => fixedKind(r.category) === fixed);
  const daysLeft = current ? dayDiff(today, range.end) + 1 : 0;

  return {
    key,
    range,
    closed,
    current,
    salaryConfirmed,
    baseIncome: round2(baseIncome),
    income,
    revenues,
    refundsToBudget: round2(refundsToBudget),
    refundsToSavings: round2(refundsToSavings),
    rows,
    groups: { fixe: group(true), variable: group(false) },
    unclassified: { tx: unclassified, spent: sum(unclassified) },
    totalSpent,
    fixedPending,
    remaining,
    perDay: daysLeft > 0 ? round2(Math.max(0, remaining) / daysLeft) : 0,
    daysLeft,
    savings,
    ignored,
    count: rows.reduce((s, r) => s + r.tx.length, 0) + unclassified.length,
  };
}

/** Remboursements encore attendus (toutes périodes). */
export const pendingRefunds = (transactions) => transactions
  .filter((t) => t.reimbursable && !t.reimbursed_at)
  .sort((a, b) => a.date.localeCompare(b.date));

/** Revenus prévus d'un mois : le salaire saisi pour ce mois, sinon les revenus habituels. */
export function incomeFor(month, months, settings) {
  const row = months.find((m) => m.month === month);
  return row && row.income !== null && row.income !== undefined ? Number(row.income) : Number(settings?.default_income || 0);
}

// ── Objectif d'épargne pour les projets ─────────────────────────────────────
/**
 * Coût des projets : la somme des prix si tous les projets en ont un,
 * sinon le montant total saisi à la main.
 * Déjà épargné : l'épargne réelle des mois terminés depuis le début de l'objectif
 * (y compris les remboursements mis directement en épargne).
 * Objectif du mois : ce qu'il reste à financer ÷ mois restants (mois en cours inclus).
 */
export function goalStatus({ settings, projects, closedSavings, todayMonth }) {
  const priced = projects.filter((p) => p.price !== null && p.price !== undefined && p.price !== '');
  const allPriced = projects.length > 0 && priced.length === projects.length;
  const cost = round2(allPriced
    ? priced.reduce((s, p) => s + Number(p.price), 0)
    : Number(settings?.projects_total || 0));

  const start = settings?.goal_start || null;
  const saved = round2(closedSavings
    .filter((m) => m.month < todayMonth && (!start || m.month >= start))
    .reduce((s, m) => s + m.savings, 0));

  const end = settings?.goal_end || null;
  const monthsLeft = end ? monthsBetween(todayMonth, end) : 0;
  const remaining = round2(Math.max(0, cost - saved));
  const monthly = monthsLeft > 0 ? round2(remaining / monthsLeft) : (end ? remaining : 0);

  return {
    cost,
    allPriced,
    pricedCount: priced.length,
    projectCount: projects.length,
    saved,
    remaining,
    monthsLeft,
    monthly,
    progress: cost > 0 ? Math.min(1, Math.max(0, saved / cost)) : 0,
    configured: cost > 0 && !!end,
  };
}

/** Comparaison des dépenses par catégorie sur plusieurs mois de budget. */
export function compareMonths(summaries) {
  const cats = new Map();
  summaries.forEach((s, i) => {
    for (const r of s.rows) {
      if (!cats.has(r.category.id)) cats.set(r.category.id, { category: r.category, values: summaries.map(() => 0) });
      cats.get(r.category.id).values[i] = r.spent;
    }
  });
  const rows = [...cats.values()].filter((r) => r.values.some((v) => v > 0))
    .sort((a, b) => b.values.at(-1) - a.values.at(-1) || b.values.reduce((x, y) => x + y) - a.values.reduce((x, y) => x + y));
  return { keys: summaries.map((s) => s.key), totals: summaries.map((s) => s.totalSpent), rows };
}

// ── Charges fixes ────────────────────────────────────────────────────────────
export const fixedKey = (chargeId, month) => `${chargeId}:${month}`;

/** Charges fixes du mois de budget en cours pas encore enregistrées (à partir de leur jour). */
export function dueFixedCharges({ fixedCharges, transactions, today = new Date(), months = [], payDay = 1 }) {
  const td = dateKey(today);
  const key = periodOf(td, months, payDay);
  const { start, end } = periodRange(key, months, payDay);
  const done = new Set(transactions.map((t) => t.fixed_key).filter(Boolean));
  const out = [];
  for (const f of fixedCharges) {
    if (f.active === false || done.has(fixedKey(f.id, key))) continue;
    const d = Math.min(28, Math.max(1, Number(f.day || 1)));
    let date = `${start.slice(0, 7)}-${pad(d)}`;
    if (date < start) date = `${end.slice(0, 7)}-${pad(d)}`;
    if (date > end || date > td) continue;
    out.push({ date, amount: round2(Number(f.amount)), category_id: f.category_id, label: f.label, source: 'fixe', fixed_key: fixedKey(f.id, key) });
  }
  return out;
}

/** Résumé envoyé à la base, pour que la notification du raccourci iPhone connaisse le reste. */
export function budgetSnapshot(summary, goalMonthly) {
  return {
    period: summary.key,
    start: summary.range.start,
    end: summary.range.end,
    remaining: summary.remaining,
    goal: goalMonthly,
    cats: Object.fromEntries(summary.rows.map((r) => [r.category.id, { n: r.category.name, b: r.budget, s: r.spent }])),
  };
}

// ── Simulations ──────────────────────────────────────────────────────────────
/**
 * Épargne régulière sur un livret : intérêts calculés chaque mois sur le solde,
 * versés au 31 décembre (comme les livrets réglementés), et comptés à la fin.
 */
export function simulateSavings({ initial = 0, monthly = 0, ratePct = 0, months = 12, startMonth }) {
  const r = Number(ratePct) / 100 / 12;
  let balance = Number(initial) || 0;
  let pending = 0;
  let interest = 0;
  const series = [{ month: startMonth ? addMonths(startMonth, -1) : null, balance: round2(balance) }];
  for (let i = 0; i < months; i++) {
    const key = startMonth ? addMonths(startMonth, i) : null;
    balance += Number(monthly) || 0;
    const gain = balance * r;
    pending += gain;
    interest += gain;
    const december = key ? key.endsWith('-12') : (i + 1) % 12 === 0;
    if (december) { balance += pending; pending = 0; }
    series.push({ month: key, balance: round2(balance + pending) });
  }
  const contributions = round2((Number(initial) || 0) + (Number(monthly) || 0) * months);
  return { final: round2(balance + pending), contributions, interest: round2(interest), series };
}

/** Mensualité d'un prêt amortissable à taux fixe. */
export function loanPayment(principal, ratePct, months) {
  const p = Number(principal) || 0;
  const n = Math.max(1, Math.round(Number(months) || 1));
  const r = Number(ratePct) / 100 / 12;
  if (r === 0) return round2(p / n);
  return round2((p * r) / (1 - Math.pow(1 + r, -n)));
}

export function simulateLoan({ principal = 0, ratePct = 0, months = 12, insuranceRatePct = 0, income = 0, otherDebts = 0 }) {
  const p = Number(principal) || 0;
  const n = Math.max(1, Math.round(Number(months) || 1));
  const r = Number(ratePct) / 100 / 12;
  const payment = loanPayment(p, ratePct, n);
  const insurance = round2((p * (Number(insuranceRatePct) / 100)) / 12);
  const monthlyTotal = round2(payment + insurance);

  const years = [];
  let remaining = p;
  let totalInterest = 0;
  let year = { year: 1, principal: 0, interest: 0 };
  for (let i = 0; i < n; i++) {
    const interest = remaining * r;
    let capital = payment - interest;
    if (i === n - 1) capital = remaining;               // dernière échéance : solde exact
    remaining = Math.max(0, remaining - capital);
    totalInterest += interest;
    year.principal += capital;
    year.interest += interest;
    if ((i + 1) % 12 === 0 || i === n - 1) {
      years.push({ year: year.year, principal: round2(year.principal), interest: round2(year.interest), remaining: round2(remaining) });
      year = { year: year.year + 1, principal: 0, interest: 0 };
    }
  }
  const totalInsurance = round2(insurance * n);
  const inc = Number(income) || 0;
  const debtRatio = inc > 0 ? (monthlyTotal + (Number(otherDebts) || 0)) / inc : null;
  return {
    payment,
    insurance,
    monthlyTotal,
    totalInterest: round2(totalInterest),
    totalInsurance,
    totalCost: round2(totalInterest + totalInsurance),
    debtRatio,
    years,
  };
}

/** Capital empruntable pour une mensualité maximale (assurance comprise). */
export function borrowingCapacity({ income = 0, maxRatio = 0.35, otherDebts = 0, ratePct = 0, months = 12, insuranceRatePct = 0 }) {
  const maxMonthly = Math.max(0, (Number(income) || 0) * maxRatio - (Number(otherDebts) || 0));
  const n = Math.max(1, Math.round(Number(months) || 1));
  const r = Number(ratePct) / 100 / 12;
  const factor = r === 0 ? 1 / n : r / (1 - Math.pow(1 + r, -n));
  const perEuro = factor + (Number(insuranceRatePct) / 100) / 12;
  return { maxMonthly: round2(maxMonthly), principal: perEuro > 0 ? Math.floor(maxMonthly / perEuro) : 0 };
}

/** Mois nécessaires pour atteindre un montant en épargnant chaque mois (sans intérêts). */
export function monthsToReach({ target = 0, current = 0, monthly = 0 }) {
  const gap = (Number(target) || 0) - (Number(current) || 0);
  if (gap <= 0) return 0;
  if (!(Number(monthly) > 0)) return Infinity;
  return Math.ceil(round2(gap / Number(monthly)) - 1e-9);
}

// ── Import / export ──────────────────────────────────────────────────────────
export const BACKUP_TABLES = ['categories', 'transactions', 'fixed_charges', 'months', 'projects', 'accounts', 'merchant_rules'];

export function validateBackup(obj) {
  if (!obj || typeof obj !== 'object') return 'Fichier illisible.';
  if (obj.app !== 'mon-budget') return 'Ce fichier ne vient pas de Mon Budget.';
  if (!obj.data || !Array.isArray(obj.data.categories)) return 'Sauvegarde incomplète (catégories manquantes).';
  for (const t of obj.data.transactions || []) {
    if (parseAmount(t.amount) === null || !/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) return 'Une dépense du fichier est invalide.';
  }
  return null;
}

export const DEFAULT_CATEGORIES = [
  { name: 'Loyer', icon: '🏠', kind: 'fixe' },
  { name: 'Abonnements', icon: '📱', kind: 'fixe' },
  { name: 'Assurances', icon: '🛡️', kind: 'fixe' },
  { name: 'Crédit / prêt', icon: '🏦', kind: 'fixe' },
  { name: 'Épargne auto', icon: '🐖', kind: 'epargne' },
  { name: 'Courses', icon: '🛒', kind: 'variable' },
  { name: 'Bar / resto', icon: '🍺', kind: 'variable' },
  { name: 'Loisirs', icon: '🎉', kind: 'variable' },
  { name: 'Sport', icon: '🏃', kind: 'variable' },
  { name: 'Vêtements', icon: '👕', kind: 'variable' },
  { name: 'Péage + essence', icon: '⛽', kind: 'variable' },
  { name: 'Transport', icon: '🚆', kind: 'variable' },
  { name: 'Santé', icon: '🩺', kind: 'variable' },
  { name: 'Coiffeur', icon: '💈', kind: 'variable' },
  { name: 'Formation', icon: '🎓', kind: 'variable' },
  { name: 'Autre', icon: '📦', kind: 'variable' },
];
