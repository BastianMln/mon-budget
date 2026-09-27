import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmount, monthKey, addMonths, monthsBetween, monthLabel, summarizePeriod, goalStatus,
  dueFixedCharges, simulateSavings, loanPayment, simulateLoan, borrowingCapacity, monthsToReach,
  validateBackup, incomeFor, euros, periodRange, periodOf, salaryTarget, periodForSalary,
  compareMonths, pendingRefunds, budgetSnapshot,
} from './calc.js';
import {
  parseStatementItems, merchantOf, ruleKey, classify, externalIds, findDuplicate, parseCsvStatement, purchaseDate,
} from './bank.js';

const close = (a, b, eps = 0.011) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

test('parseAmount lit les formats de l’iPhone et de la saisie', () => {
  assert.equal(parseAmount('12,50 €'), 12.5);
  assert.equal(parseAmount('€12.50'), 12.5);
  assert.equal(parseAmount('1 234,56 €'), 1234.56);
  assert.equal(parseAmount('1 234,56 €'), 1234.56);
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('-8,00 €'), 8);
  assert.equal(parseAmount(',5'), 0.5);
  assert.equal(parseAmount(42), 42);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(''), null);
});

test('outils de mois', () => {
  assert.equal(monthKey(new Date(2026, 8, 26)), '2026-09');
  assert.equal(addMonths('2026-11', 3), '2027-02');
  assert.equal(monthsBetween('2026-10', '2027-05'), 8);
  assert.equal(monthLabel('2026-10'), 'octobre 2026');
  assert.equal(monthLabel('2026-09', { short: true }), 'sept. 2026');
});

test('mois de budget : d’une paie à la suivante', () => {
  assert.deepEqual(periodRange('2026-09', [], 1), { start: '2026-09-01', end: '2026-09-30' });
  assert.deepEqual(periodRange('2026-09', [], 26), { start: '2026-08-26', end: '2026-09-25' });
  assert.deepEqual(periodRange('2026-03', [], 31), { start: '2026-02-28', end: '2026-03-30' });
  assert.equal(periodOf('2026-09-27', [], 26), '2026-10');
  assert.equal(periodOf('2026-09-25', [], 26), '2026-09');
  // salaire arrivé le 24 : le mois suivant démarre ce jour-là
  const m = [{ month: '2026-10', start_date: '2026-09-24', income: 1700 }];
  assert.deepEqual(periodRange('2026-09', m, 26), { start: '2026-08-26', end: '2026-09-23' });
  assert.equal(periodOf('2026-09-24', m, 26), '2026-10');
  assert.equal(salaryTarget('2026-09-27', [], 26), '2026-10');
  assert.equal(salaryTarget('2026-10-24', [{ month: '2026-10', income: 1700 }], 26), '2026-11');
  assert.equal(periodForSalary('2026-09-24', 26), '2026-10');
  assert.equal(periodForSalary('2026-10-02', 1), '2026-10');
});

// ── Un mois fictif (paie le 1er) ────────────────────────────────────────────
const cats = [
  { id: 'loyer', name: 'Loyer', kind: 'fixe', budget: 700, position: 0 },
  { id: 'abo', name: 'Abonnements', kind: 'fixe', budget: 30, position: 1 },
  { id: 'ep', name: 'Épargne auto', kind: 'epargne', budget: 100, position: 2 },
  { id: 'vet', name: 'Vêtements', kind: 'variable', budget: 150, position: 3 },
  { id: 'cour', name: 'Courses', kind: 'variable', budget: 0, position: 4 },
  { id: 'autre', name: 'Autre', kind: 'variable', budget: 0, position: 5 },
];
const tx = (date, amount, category_id, extra = {}) => ({ id: `${date}-${amount}-${category_id}`, date, amount, category_id, ...extra });
const sept = [
  tx('2026-09-01', 700, 'loyer'), tx('2026-09-01', 30, 'abo'), tx('2026-09-01', 100, 'ep'),
  tx('2026-09-04', 90, 'vet'), tx('2026-09-06', 60, 'cour'), tx('2026-09-10', 40, 'cour'),
  tx('2026-09-12', 100 / 3, 'autre'), tx('2026-09-15', 15, 'autre'), tx('2026-09-18', 12.5, 'autre'),
  tx('2026-09-22', 70, 'cour'), tx('2026-09-23', 25, null),
];
const settings = { default_income: 2000, pay_day: 1 };
const sum = (key, today, list = sept, extra = {}) => summarizePeriod({ key, today, categories: cats, transactions: list, settings, ...extra });

test('mois terminé : épargne = revenus − dépensé', () => {
  const s = sum('2026-09', '2026-10-05');
  assert.equal(s.closed, true);
  close(s.totalSpent, 1175.83);
  close(s.savings, 824.17);
  assert.equal(s.unclassified.tx.length, 1);
});

test('budget restant = revenus − objectif − dépensé − charges fixes à venir', () => {
  const s = sum('2026-09', '2026-09-20', sept, { goalMonthly: 300 });
  assert.equal(s.current, true);
  close(s.remaining, 2000 - 300 - 1175.83);
  assert.equal(s.daysLeft, 11);
  close(s.perDay, (2000 - 300 - 1175.83) / 11);
  // loyer pas encore passé : il est déduit d'avance
  const sansLoyer = sept.filter((t) => t.category_id !== 'loyer');
  const s2 = sum('2026-09', '2026-09-20', sansLoyer, { goalMonthly: 300 });
  close(s2.fixedPending, 700);
  close(s2.remaining, s.remaining);
});

test('dépense lissée : 1/N dans chacun des N mois', () => {
  const list = [tx('2026-09-10', 64, 'autre', { spread_months: 3 })];
  close(sum('2026-09', '2026-09-15', list).totalSpent, 21.33);
  const oct = sum('2026-10', '2026-10-15', list);
  close(oct.totalSpent, 21.33);
  assert.equal(oct.rows.find((r) => r.category.id === 'autre').tx[0].part, '2/3');
  close(sum('2026-11', '2026-11-15', list).totalSpent, 21.33);
  close(sum('2026-12', '2026-12-15', list).totalSpent, 0);
});

test('remboursements attendus : hors dépenses, puis vers l’épargne ou le budget', () => {
  const avance = tx('2026-09-05', 264, 'autre', { reimbursable: true });
  assert.equal(sum('2026-09', '2026-09-15', [avance]).totalSpent, 0);
  assert.equal(pendingRefunds([avance]).length, 1);
  const epargne = { ...avance, reimbursed_at: '2026-10-03', reimbursed_to: 'epargne' };
  const o1 = sum('2026-10', '2026-10-31', [epargne]);
  assert.equal(o1.refundsToSavings, 264);
  assert.equal(o1.income, 2000);
  const budget = { ...avance, reimbursed_at: '2026-10-03', reimbursed_to: 'budget' };
  assert.equal(sum('2026-10', '2026-10-31', [budget]).income, 2264);
  assert.equal(pendingRefunds([epargne]).length, 0);
});

test('revenus en plus et virements ignorés', () => {
  const list = [tx('2026-09-10', 80, null, { kind: 'revenu' }), tx('2026-09-11', 200, null, { kind: 'ignore' })];
  const s = sum('2026-09', '2026-09-15', list);
  assert.equal(s.income, 2080);
  assert.equal(s.totalSpent, 0);
  assert.equal(s.ignored, 1);
  const confirmed = sum('2026-09', '2026-09-15', [], { months: [{ month: '2026-09', income: 1700 }] });
  assert.equal(confirmed.income, 1700);
  assert.equal(confirmed.salaryConfirmed, true);
});

test('objectif projets : recalculé chaque mois selon l’épargne réelle', () => {
  const st = { projects_total: 3000, goal_start: '2026-09', goal_end: '2027-05' };
  const projects = [{ name: 'Kayak', price: null }, { name: 'Vélo', price: 300 }];
  close(goalStatus({ settings: st, projects, closedSavings: [], todayMonth: '2026-09' }).monthly, 333.33);
  const oct = goalStatus({ settings: st, projects, closedSavings: [{ month: '2026-09', savings: 824.17 }], todayMonth: '2026-10' });
  close(oct.saved, 824.17);
  close(oct.monthly, 271.98);
  const all = goalStatus({ settings: { projects_total: 5000, goal_end: '2026-12' }, projects: [{ price: 100 }, { price: 250.5 }], closedSavings: [], todayMonth: '2026-10' });
  assert.equal(all.cost, 350.5);
});

test('charges fixes : une fois par mois de budget, à partir de leur jour', () => {
  const fixed = [{ id: 'f1', category_id: 'loyer', label: 'Loyer', amount: 700, day: 1 },
    { id: 'f2', category_id: 'abo', label: 'Musique', amount: 30, day: 10 }];
  const d = dueFixedCharges({ fixedCharges: fixed, transactions: [], today: new Date(2026, 9, 5) });
  assert.deepEqual(d.map((x) => x.fixed_key), ['f1:2026-10']);
  const again = dueFixedCharges({ fixedCharges: fixed, transactions: [{ fixed_key: 'f1:2026-10' }], today: new Date(2026, 9, 12) });
  assert.deepEqual(again.map((x) => x.fixed_key), ['f2:2026-10']);
  // paie le 26 : le 27 septembre on est dans le budget d'octobre, le loyer du 1er n'est pas encore dû
  assert.equal(dueFixedCharges({ fixedCharges: fixed, transactions: [], today: new Date(2026, 8, 27), payDay: 26 }).length, 0);
  const oct2 = dueFixedCharges({ fixedCharges: fixed, transactions: [], today: new Date(2026, 9, 2), payDay: 26 });
  assert.deepEqual(oct2.map((x) => [x.fixed_key, x.date]), [['f1:2026-10', '2026-10-01']]);
});

test('comparaison entre les mois et résumé pour la notification', () => {
  const list = [...sept, tx('2026-10-03', 50, 'cour')];
  const a = sum('2026-09', '2026-10-05', list);
  const b = sum('2026-10', '2026-10-05', list);
  const c = compareMonths([a, b]);
  const courses = c.rows.find((r) => r.category.id === 'cour');
  assert.deepEqual(courses.values, [170, 50]);
  const snap = budgetSnapshot(b, 200);
  assert.equal(snap.cats.cour.s, 50);
  assert.equal(snap.start, '2026-10-01');
});

test('simulations', () => {
  assert.equal(simulateSavings({ initial: 0, monthly: 100, ratePct: 0, months: 12 }).final, 1200);
  close(simulateSavings({ initial: 0, monthly: 100, ratePct: 1.7, months: 12, startMonth: '2026-01' }).interest, 11.05, 0.02);
  close(loanPayment(200000, 3.5, 300), 1001.25, 0.02);
  const l = simulateLoan({ principal: 10000, ratePct: 4, months: 48, insuranceRatePct: 0.3, income: 2000 });
  close(l.payment, 225.79);
  close(l.years.at(-1).remaining, 0);
  const cap = borrowingCapacity({ income: 2000, ratePct: 0, months: 12 });
  assert.equal(cap.principal, 8400);
  assert.equal(monthsToReach({ target: 3000, current: 824.17, monthly: 271.98 }), 8);
  assert.equal(monthsToReach({ target: 100, current: 0, monthly: 0 }), Infinity);
});

test('revenus du mois et sauvegarde', () => {
  assert.equal(incomeFor('2026-10', [{ month: '2026-10', income: 2100 }], { default_income: 2000 }), 2100);
  assert.equal(incomeFor('2026-11', [{ month: '2026-11', income: null }], { default_income: 2000 }), 2000);
  assert.equal(validateBackup({ app: 'autre' }), 'Ce fichier ne vient pas de Mon Budget.');
  assert.match(euros(1234.5), /1\s?234,50\s?€/);
});

// ── Relevés bancaires ────────────────────────────────────────────────────────
/** Relevé fictif mis en page comme ceux de LCL (colonnes DÉBIT à ~460, CRÉDIT à ~537). */
function fakeStatement() {
  const it = [];
  const put = (str, x, y, w = str.length * 5, page = 1) => it.push({ str, x, y, w, page });
  put('LCL Le Credit Lyonnais', 40, 800);
  put('du 01.08.2026 au 31.08.2026 - N° 6', 397, 767, 164);
  put('DATE', 42, 393, 24); put('LIBELLE', 197, 393, 38); put('VALEUR', 365, 393, 37); put('DEBIT', 433, 393, 27); put('CREDIT', 504, 393, 33);
  put('31.07', 42, 369, 23); put('ANCIEN SOLDE', 286, 369, 68); put('825,00', 531, 369, 28);
  const op = (y, d, label, amount, credit = false) => {
    put(d, 43, y, 23); put(label, 75, y, 120); put(`${d}.26`, 366, y, 35);
    put(amount, credit ? 559 - amount.length * 4.6 : 481 - amount.length * 4.6, y, amount.length * 4.6);
  };
  op(345, '04.08', 'VIR SEPA dupont alex', '238,00');
  op(321, '07.08', 'CB RETRAIT DU 06/08', '10,00');
  put('SERIGNAN', 81, 309, 42);
  op(297, '07.08', 'CB ESCOTA BANDOL P/ 06/08/26', '2,60');
  op(285, '07.08', 'CB CAFE VOGUE 06/08/26', '3,00');
  op(273, '07.08', 'CB CAFE VOGUE 06/08/26', '3,00');
  op(261, '14.08', 'ECHEANCE PRET PERSONNEL 140826', '33,82');
  put('21700141308243148609976PP999226', 81, 249, 150);
  op(237, '19.08', 'VIR INST MR DUPONT ALEX', '50,00', true);
  op(225, '26.08', 'VIR SEPA SALAIRE ACME SAS', '1 700,00', true);
  op(213, '28.08', 'VIR INST CLAIRE B', '15,00');
  put('K6EXTP32', 540, 190, 40);
  put('TOTAUX', 286, 170, 30); put('305,42', 453, 170, 28); put('2 575,00', 523, 170, 36);
  put('31.08', 42, 150, 23); put('SOLDE EN EUROS', 286, 150, 70); put('2 111,58', 523, 150, 36);
  return it;
}

test('lecture d’un relevé PDF (mise en page LCL)', () => {
  const r = parseStatementItems(fakeStatement());
  assert.equal(r.bank.id, 'lcl');
  assert.deepEqual(r.period, { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(r.ops.length, 9);
  close(r.ops.filter((o) => o.direction === 'debit').reduce((s, o) => s + o.amount, 0), 305.42);
  close(r.ops.filter((o) => o.direction === 'credit').reduce((s, o) => s + o.amount, 0), 1750);
  assert.equal(r.opening, 825);
  assert.equal(r.closing, 2111.58);
  const escota = r.ops.find((o) => o.label.includes('ESCOTA'));
  assert.equal(escota.date, '2026-08-06');         // date d'achat, pas de passage
  assert.equal(escota.bookDate, '2026-08-07');
  assert.equal(r.ops.find((o) => o.label.includes('RETRAIT')).detail, 'SERIGNAN');
  assert.equal(r.ops.find((o) => o.label.includes('PRET')).detail, '');
});

test('classement automatique des opérations', () => {
  const r = parseStatementItems(fakeStatement());
  const categories = cats.concat([{ id: 'peage', name: 'Péage + essence', kind: 'variable' }, { id: 'bar', name: 'Bar / resto', kind: 'variable' }]);
  const ctx = { categories, rules: [{ merchant: 'echeance pret personnel', action: 'rembourse' }], ownerNames: ['Alex Dupont'], defaultIncome: 1700 };
  const by = (s) => classify(r.ops.find((o) => o.label.includes(s)), ctx);
  assert.equal(by('VIR SEPA dupont').kind, 'ignore');
  assert.equal(by('VIR INST MR DUPONT').kind, 'ignore');
  assert.equal(by('ESCOTA').category_id, 'peage');
  assert.equal(by('CAFE VOGUE').category_id, 'bar');
  assert.equal(by('PRET').reimbursable, true);
  assert.equal(by('SALAIRE').kind, 'salaire');
  assert.equal(by('CLAIRE B').category_id, null);
  assert.equal(by('CLAIRE B').reason, 'Envoi à une personne');
  // règle apprise prioritaire
  const learned = classify(r.ops.find((o) => o.label.includes('CAFE')), { ...ctx, rules: [{ merchant: 'cafe vogue', category_id: 'autre', action: 'categorie' }] });
  assert.equal(learned.category_id, 'autre');
});

test('libellés, identifiants et doublons', () => {
  assert.equal(merchantOf('CB PAIN SAS 7EPIS 06/08/26'), 'PAIN SAS 7EPIS');
  assert.equal(merchantOf('CB ESCOTA BANDOL P/ 06/08/26'), 'ESCOTA BANDOL');
  assert.equal(merchantOf('ECHEANCE PRET PERSONNEL 140826'), 'ECHEANCE PRET PERSONNEL');
  assert.equal(merchantOf('CB Lydia*Lou marie 23/08/26'), 'LYDIA LOU MARIE');
  assert.equal(ruleKey('Café Vogue'), 'cafe vogue');
  assert.equal(purchaseDate('CB RETRAIT DU 06/08', '2026-08-07'), '2026-08-06');
  assert.equal(purchaseDate('CB X 30/12/25', '2026-01-02'), '2025-12-30');
  const r = parseStatementItems(fakeStatement());
  const ids = externalIds('lcl', r.ops);
  assert.equal(new Set(ids).size, ids.length);          // deux « CAFE VOGUE 3,00 » le même jour restent distincts
  const applePay = [{ id: 'a1', date: '2026-08-07', amount: 3, source: 'raccourci' }];
  const cafe = r.ops.filter((o) => o.label.includes('CAFE'));
  const used = new Set();
  const d1 = findDuplicate(cafe[0], applePay, used); used.add(d1?.id);
  assert.equal(d1.id, 'a1');
  assert.equal(findDuplicate(cafe[1], applePay, used), null);
});

test('lecture d’un export CSV', () => {
  const csv = 'Date;Libellé;Débit;Crédit\n05/09/2026;CB MONOPRIX 04/09/26;12,40;\n06/09/2026;VIR SALAIRE;;1 700,00\n';
  const r = parseCsvStatement(csv);
  assert.equal(r.ops.length, 2);
  assert.deepEqual([r.ops[0].date, r.ops[0].amount, r.ops[0].direction], ['2026-09-04', 12.4, 'debit']);
  assert.deepEqual([r.ops[1].amount, r.ops[1].direction], [1700, 'credit']);
  const bourso = 'dateOp;dateVal;label;category;categoryParent;supplierFound;amount;comment;accountNum;accountLabel;accountbalance\n2026-09-03;2026-09-03;"CARTE 02/09/26 LIDL";Alimentation;Vie quotidienne;lidl;-23,10;;123;BoursoBank;512,30\n';
  const b = parseCsvStatement(bourso);
  assert.deepEqual([b.ops[0].date, b.ops[0].amount, b.ops[0].direction], ['2026-09-02', 23.1, 'debit']);
  assert.equal(b.closing, 512.3);
});
