// ─────────────────────────────────────────────────────────────────────────────
// Mon Budget — interface
// ─────────────────────────────────────────────────────────────────────────────
import * as C from './calc.js';
import * as B from './bank.js';
import {
  createStore, saveDeviceConfig, setLocalMode, storage, newId, newToken, StoreError,
} from './store.js';

const VERSION = '2.0.0';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => esc(C.euros(n));
const inputNum = (n) => (n === null || n === undefined || n === '' ? '' : String(C.round2(n)).replace('.', ','));

// Taux réglementés au 1er août 2026 (sources : economie.gouv.fr) — modifiables dans l'app.
const PRESETS = [
  { name: 'Compte courant', kind: 'courant', rate: 0 },
  { name: 'Livret A', kind: 'livret', rate: 1.7 },
  { name: 'LDDS', kind: 'livret', rate: 1.7 },
  { name: 'LEP', kind: 'livret', rate: 2.5 },
  { name: 'PEL', kind: 'pel', rate: null },
  { name: 'Assurance vie', kind: 'assurance_vie', rate: null },
];
const KINDS = {
  courant: ['💳', 'Compte courant'], livret: ['🐷', 'Livret'], pel: ['🏡', 'PEL'],
  assurance_vie: ['🛡️', 'Assurance vie'], bourse: ['📈', 'Bourse / PEA'], autre: ['💼', 'Autre'],
};
const CAT_KINDS = { fixe: 'Chaque mois', epargne: 'Épargne', variable: 'Vie courante' };

const S = {
  store: null,
  user: null,
  data: null,
  screen: 'loading',       // loading | config | auth | welcome | app | error
  view: storage.get('mb.view') || 'mois',
  month: null,             // mois de budget affiché (AAAA-MM)
  imp: null,               // relevé en cours de vérification
  wiz: null,               // assistant de démarrage
  loadedAt: null,
  expanded: new Set(),
  sheet: null,
  authMode: 'login',
  authMsg: null,
  prefill: null,
  sim: { tab: 'epargne', ...(storage.get('mb.sim') || {}) },
  error: null,
  busy: false,
  sync: 'off',             // live | local | error | off
};

// ── Données dérivées ────────────────────────────────────────────────────────
const outboxKey = () => `mb.outbox.${S.user?.id || 'x'}`;
const outbox = () => storage.get(outboxKey()) || [];
const allTx = () => [...(S.data?.transactions || []), ...outbox().map((t) => ({ ...t, pending: true }))];
const catById = (id) => S.data.categories.find((c) => c.id === id);
const activeCats = () => [...S.data.categories].filter((c) => !c.archived).sort((a, b) => a.position - b.position);

const payDay = () => Number(S.data?.settings?.pay_day || 1);
const todayKey = () => C.dateKey();
const currentKey = () => C.periodOf(todayKey(), S.data.months, payDay());
const ownerNames = () => (S.data.settings?.owner_names || '').split(',').map((s) => s.trim()).filter(Boolean);

function rawSummary(key, goalMonthly = 0) {
  return C.summarizePeriod({
    key, today: todayKey(), categories: S.data.categories, transactions: allTx(),
    months: S.data.months, settings: S.data.settings, goalMonthly,
  });
}

// Objectif d'épargne : recalculé une fois par affichage
let goalCache = null;
function goal() {
  if (goalCache) return goalCache;
  const cur = currentKey();
  const start = S.data.settings?.goal_start;
  const closedSavings = [];
  if (start) {
    for (let m = start, i = 0; m < cur && i < 240; m = C.addMonths(m, 1), i++) {
      closedSavings.push({ month: m, savings: rawSummary(m).savings });
    }
  }
  goalCache = C.goalStatus({ settings: S.data.settings, projects: S.data.projects, closedSavings, todayMonth: cur });
  return goalCache;
}

function summaryOf(key) {
  const g = goal();
  return rawSummary(key, key >= currentKey() && g.configured ? g.monthly : 0);
}

const fixedBudgets = () => C.round2(S.data.categories
  .filter((c) => !c.archived && (c.kind === 'fixe' || c.kind === 'epargne'))
  .reduce((s, c) => s + Number(c.budget || 0), 0));
const usualIncome = () => Number(S.data.settings?.default_income || 0);

// ── Démarrage ───────────────────────────────────────────────────────────────
async function boot() {
  registerServiceWorker();
  readUrlParams();
  try {
    S.store = createStore();
  } catch (e) {
    S.screen = 'error';
    S.error = e.message;
    return render();
  }
  if (!S.store) { S.screen = 'config'; return render(); }

  S.store.onAuth(async (event, user) => {
    if (event === 'PASSWORD_RECOVERY') { S.sheet = { type: 'recovery' }; render(); return; }
    if (event === 'SIGNED_IN' && user) await enterApp(user);
    if (event === 'SIGNED_OUT') { stopSync(); entering = null; S.user = null; S.data = null; S.screen = 'auth'; S.authMode = 'login'; render(); }
  });

  let user = null;
  try { user = await S.store.getUser(); } catch { user = null; }
  if (!user) { S.screen = 'auth'; return render(); }
  return enterApp(user);
}

// Un seul chargement par connexion, même si Supabase signale la connexion plusieurs fois
let entering = null;
async function enterApp(user) {
  if (!user || entering === user.id) return;
  entering = user.id;
  S.user = user;
  await loadData();
  startSync();
}

// ── Synchronisation en direct entre appareils ───────────────────────────────
let unsubscribe = null;
let syncTimer = null;
const isEditing = () => {
  const a = document.activeElement;
  return !!a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && !!$('#view')?.contains(a);
};
function startSync() {
  stopSync();
  if (!S.store?.subscribe) return;
  unsubscribe = S.store.subscribe(scheduleSync, (status) => {
    const before = S.sync;
    S.sync = status === 'SUBSCRIBED' ? 'live' : status === 'LOCAL' ? 'local' : 'error';
    if (before !== S.sync && S.screen === 'app' && S.view === 'reglages' && !isEditing() && !S.sheet) render();
  });
}
function stopSync() {
  clearTimeout(syncTimer);
  unsubscribe?.();
  unsubscribe = null;
  S.sync = 'off';
}
// Recharge peu après un changement ; attend si tu es en train de saisir quelque chose.
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    if (S.screen !== 'app') return;
    if (S.sheet || isEditing()) { scheduleSync(); return; }
    lastRefresh = Date.now();
    loadData({ quiet: true });
  }, 600);
}

function readUrlParams() {
  const p = new URLSearchParams(location.search);
  if (p.has('ajout') || p.has('montant')) {
    S.prefill = { amount: C.parseAmount(p.get('montant')), merchant: p.get('marchand') || null, source: 'raccourci' };
    history.replaceState(null, '', location.pathname);
  }
}

async function loadData({ quiet = false } = {}) {
  if (!quiet) { S.screen = 'loading'; render(); }
  try {
    const at = new Date().toISOString();
    S.data = await S.store.loadAll();
    S.loadedAt = at;
    await flushOutbox();
    if (S.data.settings) await ensureFixed();
    S.screen = S.data.settings ? 'app' : 'welcome';
    S.error = null;
  } catch (e) {
    if (quiet && S.data) toast(e.message, 'error');
    else { S.screen = 'error'; S.error = e.message; }
  }
  render();
  if (S.screen === 'app' && S.prefill) { openAdd(S.prefill); S.prefill = null; }
}

async function ensureFixed() {
  const due = C.dueFixedCharges({ fixedCharges: S.data.fixed_charges, transactions: S.data.transactions, months: S.data.months, payDay: payDay() });
  if (!due.length) return;
  const rows = await S.store.upsert('transactions', due, { ignoreDuplicates: true });
  S.data.transactions.push(...rows);
}

async function flushOutbox() {
  const list = outbox();
  if (!list.length) return;
  const keep = [];
  for (const row of list) {
    if (S.data.transactions.some((t) => t.id === row.id)) continue;
    try {
      const [saved] = await S.store.insert('transactions', [row]);
      S.data.transactions.push(saved);
    } catch (e) {
      if (e.code === '23505') continue;           // déjà envoyée
      if (e.network) keep.push(row);
      else toast(`Dépense non enregistrée : ${e.message}`, 'error');
    }
  }
  storage.set(outboxKey(), keep);
}

// Rafraîchit quand on revient sur l'app (dépenses ajoutées depuis l'autre appareil ou l'iPhone)
let lastRefresh = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || S.screen !== 'app') return;
  if (S.sync === 'error' || S.sync === 'off') startSync();       // l'iPhone coupe la connexion en arrière-plan
  if (!S.sheet && Date.now() - lastRefresh > 5000) {
    lastRefresh = Date.now();
    loadData({ quiet: true });
  }
});
window.addEventListener('online', () => { if (S.screen === 'app') loadData({ quiet: true }); });

// ── Rendu ────────────────────────────────────────────────────────────────────
function render() {
  goalCache = null;
  const view = $('#view');
  if (S.data?.settings && !S.month) S.month = currentKey();
  const inApp = S.screen === 'app';
  document.body.classList.toggle('in-app', inApp);
  if (inApp) {
    storage.set('mb.view', S.view);
    view.innerHTML = S.imp ? viewImport()
      : { mois: viewMonth, projets: viewProjects, comptes: viewAccounts, simus: viewSims, reglages: viewSettings }[S.view]();
    document.body.classList.toggle('importing', !!S.imp);
    document.querySelectorAll('#tabs [data-view]').forEach((b) => b.setAttribute('aria-current', b.dataset.view === S.view ? 'page' : 'false'));
    if (S.view === 'simus') renderSim();
  } else {
    view.innerHTML = { loading: viewLoading, config: viewConfig, auth: viewAuth, welcome: viewWelcome, error: viewError }[S.screen]();
  }
  renderSheet();
  if (inApp) scheduleSnapshot();
}

const viewLoading = () => '<div class="center muted"><div class="spinner" aria-label="Chargement"></div></div>';
const viewError = () => `<div class="center"><p class="err">${esc(S.error)}</p>
  <button class="btn" data-act="retry">Réessayer</button>
  ${S.store?.mode === 'cloud' ? '<button class="btn ghost" data-act="logout">Se déconnecter</button>' : ''}</div>`;

// ── Écran : Accueil (mois de budget) ────────────────────────────────────────
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS_L = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const longDate = (d = new Date()) => `${JOURS[d.getDay()]} ${d.getDate()} ${MOIS_L[d.getMonth()]}`;

function viewMonth() {
  const key = S.month;
  const s = summaryOf(key);
  const g = goal();
  const cur = currentKey();
  const future = key > cur;
  const pending = outbox().length;
  const refunds = C.pendingRefunds(S.data.transactions);
  const today = todayKey();
  const nextSalarySoon = s.current && C.addDays(s.range.end, -4) <= today;
  const needSalary = s.current && !s.salaryConfirmed;

  const hero = s.closed
    ? `<section class="hero ${s.savings < 0 ? 'neg' : ''}">
        <div class="hero-label">Épargné sur ce mois</div>
        <div class="hero-amount">${money(s.savings)}</div>
        <div class="hero-goal">Revenus ${money(s.income)} · Dépenses ${money(s.totalSpent)}</div>
      </section>`
    : `<section class="hero ${s.remaining < 0 ? 'neg' : ''}">
        <div class="hero-label">${future ? 'Budget prévu' : 'Budget restant'}</div>
        <div class="hero-amount" data-testid="restant">${money(s.remaining)}</div>
        ${s.current && s.daysLeft > 0 ? `<div class="hero-goal">${s.remaining >= 0
          ? `soit ${money(s.perDay)} par jour pendant ${s.daysLeft} jour${s.daysLeft > 1 ? 's' : ''}`
          : 'tu as dépassé ton budget du mois'}</div>` : ''}
        ${g.configured
          ? `<p class="hero-free">Ton épargne pour tes projets (<b>${money(g.monthly)}</b>) est déjà mise de côté dans ce calcul.</p>`
          : '<button class="hero-link" data-act="tab" data-view="projets">Définir un objectif d’épargne →</button>'}
      </section>`;

  return `
  <p class="today">${esc(longDate())}</p>
  <header class="top">
    <button class="icon-btn" data-act="month-prev" aria-label="Mois précédent">‹</button>
    <div class="month-head">
      <h1 class="month-title">${esc(C.monthLabel(key))}</h1>
      <small class="muted">${esc(C.rangeLabel(s.range))}${key !== cur ? ' · <button class="chip" data-act="month-today">Revenir à aujourd’hui</button>' : ''}</small>
    </div>
    <button class="icon-btn" data-act="month-next" aria-label="Mois suivant">›</button>
  </header>

  ${hero}

  <div class="stats">
    <div class="stat main"><span>Dépenses du mois</span><b data-testid="depenses">${money(s.totalSpent)}</b></div>
    <button class="stat" data-act="edit-income"><span>Revenus ${s.salaryConfirmed || s.closed ? '✎' : '(prévus) ✎'}</span><b>${money(s.income)}</b></button>
    <div class="stat"><span>Charges à venir</span><b>${money(s.fixedPending)}</b></div>
  </div>

  ${needSalary ? `<button class="banner action" data-act="salary">💶 Ton salaire de ${esc(C.monthLabel(key))} est arrivé ? <b>Salaire reçu</b></button>`
    : nextSalarySoon ? `<button class="banner action" data-act="salary">💶 Ta prochaine paie arrive bientôt. Dès qu’elle est là : <b>Salaire reçu</b></button>` : ''}
  ${pending ? `<p class="banner">⏳ ${pending} dépense${pending > 1 ? 's' : ''} en attente de connexion</p>` : ''}

  ${s.unclassified.tx.length ? `
  <section class="card inbox">
    <h2>À classer <span class="count">${s.unclassified.tx.length}</span></h2>
    <p class="note">Touche une dépense pour lui donner une catégorie. L’app retiendra le commerçant.</p>
    ${s.unclassified.tx.map(txRow).join('')}
  </section>` : ''}

  ${refunds.length ? `
  <section class="card refunds">
    <h2>Remboursements attendus <span class="muted">${money(refunds.reduce((a, t) => a + Number(t.amount), 0))}</span></h2>
    <p class="note">Ces avances ne comptent pas dans tes dépenses. Touche « Remboursé » quand l’argent revient.</p>
    ${refunds.map((t) => `<div class="refund-row">
      <button class="tx" data-act="edit-tx" data-id="${esc(t.id)}"><span class="tx-date">${esc(C.dayLabel(t.date))}</span>
        <span class="tx-label">${esc(t.label || t.merchant || 'Avance')}</span><b>${money(t.amount)}</b></button>
      <button class="btn small" data-act="refund" data-id="${esc(t.id)}">Remboursé</button></div>`).join('')}
  </section>` : ''}

  ${groupBlock('Chaque mois', s.groups.fixe)}
  ${groupBlock('Vie de tous les jours', s.groups.variable)}

  ${s.revenues.length ? `<section class="group"><h2>Rentrées d’argent en plus <span class="muted">${money(s.revenues.reduce((a, t) => a + Number(t.amount), 0))}</span></h2>
    <div class="card list">${s.revenues.map(txRow).join('')}</div></section>` : ''}

  ${s.count === 0 ? '<p class="empty">Aucune dépense sur ce mois. Touche <b>+</b> pour en ajouter une.</p>' : ''}

  ${comparisonBlock(key)}

  <button class="btn ghost block" data-act="statement-pick">📄 Importer un relevé bancaire (PDF ou CSV)</button>
  <input type="file" id="statement-file" accept=".pdf,.csv,application/pdf,text/csv" hidden>
  <div class="fab-space"></div>`;
}

/**
 * Comparaison : une barre par catégorie pour ce mois, un trait pour la moyenne
 * des 3 mois précédents (une seule série colorée, la référence reste neutre).
 */
function comparisonBlock(key) {
  const keys = [3, 2, 1, 0].map((i) => C.addMonths(key, -i));
  const sums = keys.map((k) => summaryOf(k));
  if (sums.slice(0, 3).every((x) => x.count === 0)) return '';
  const cmp = C.compareMonths(sums);
  const rows = cmp.rows.slice(0, 8).map((r) => ({
    ...r, now: r.values[3], avg: C.round2((r.values[0] + r.values[1] + r.values[2]) / 3),
  }));
  const max = Math.max(1, ...rows.map((r) => Math.max(r.now, r.avg)));
  const tmax = Math.max(1, ...cmp.totals);
  return `<section class="group compare">
    <h2>Comparaison <span class="muted">ce mois · moyenne des 3 précédents</span></h2>
    <div class="card pad-card">
      <div class="totals" role="img" aria-label="Dépenses totales des 4 derniers mois">
        ${cmp.keys.map((k, i) => `<div class="tcol ${i === 3 ? 'now' : ''}" title="${esc(C.monthLabel(k))} : ${esc(C.euros(cmp.totals[i]))}">
          <div class="tbar-wrap"><i style="height:${Math.max(2, (cmp.totals[i] / tmax) * 100)}%"></i></div>
          <b>${esc(C.euros(cmp.totals[i]).replace(/,\d\d/, ''))}</b><small>${esc(C.monthLabel(k, { short: true }).split(' ')[0])}</small></div>`).join('')}
      </div>
      <div class="legend"><span><i class="sw"></i>ce mois</span><span><i class="tick"></i>moyenne des 3 mois précédents</span></div>
      ${rows.map((r) => {
        const diff = C.round2(r.now - r.avg);
        return `<div class="crow" title="${esc(r.category.name)} : ${esc(C.euros(r.now))} (moyenne ${esc(C.euros(r.avg))})">
          <span class="cname">${esc(r.category.icon)} ${esc(r.category.name)}</span>
          <span class="cbar"><i style="width:${(r.now / max) * 100}%"></i>${r.avg > 0 ? `<em style="left:${(r.avg / max) * 100}%"></em>` : ''}</span>
          <span class="cval"><b>${money(r.now)}</b><small class="${diff > 0.5 ? 'ko' : diff < -0.5 ? 'ok' : 'muted'}">${Math.abs(diff) < 0.5 ? '=' : `${diff > 0 ? '+' : '−'}${esc(C.euros(Math.abs(diff)))}`}</small></span>
        </div>`;
      }).join('')}
    </div>
  </section>`;
}

// ── Résumé pour la notification du raccourci iPhone ─────────────────────────
let snapTimer = null;
let lastSnapSig = '';
function scheduleSnapshot() {
  if (S.store?.mode !== 'cloud' || !S.data?.settings) return;
  clearTimeout(snapTimer);
  snapTimer = setTimeout(writeSnapshot, 1500);
}
async function writeSnapshot() {
  if (!S.data?.settings) return;
  goalCache = null;
  const g = goal();
  const cur = currentKey();
  const snap = C.budgetSnapshot(summaryOf(cur), g.configured ? g.monthly : 0);
  const sig = JSON.stringify(snap);
  const stored = S.data.settings.snapshot ? JSON.stringify({ ...S.data.settings.snapshot, at: undefined }) : '';
  if (sig === lastSnapSig || sig === stored) { lastSnapSig = sig; return; }
  lastSnapSig = sig;
  // « at » : tout ce qui a été créé après cet instant n'est pas encore compté dans ce résumé
  const times = S.data.transactions.map((t) => t.created_at).filter(Boolean).sort();
  const at = [S.loadedAt, times.at(-1)].filter(Boolean).sort().at(-1) || new Date().toISOString();
  const full = { ...snap, at };
  try {
    await S.store.update('settings', { user_id: S.data.settings.user_id }, { snapshot: full });
    S.data.settings.snapshot = full;
  } catch { /* sans gravité : réessayé au prochain affichage */ }
}

function groupBlock(title, rows) {
  const shown = rows.filter((r) => r.budget > 0 || r.spent > 0 || r.tx.length);
  if (!shown.length) return '';
  const spent = C.round2(shown.reduce((a, r) => a + r.spent, 0));
  const budget = C.round2(shown.reduce((a, r) => a + r.budget, 0));
  const allBudgeted = shown.every((r) => r.budget > 0);
  return `<section class="group">
    <h2>${esc(title)} <span class="muted">${money(spent)}${allBudgeted && budget ? ` / ${money(budget)}` : ''}</span></h2>
    <div class="card list">${shown.map(catRow).join('')}</div>
  </section>`;
}

function catRow(r) {
  const c = r.category;
  const open = S.expanded.has(c.id);
  const pct = r.budget > 0 ? Math.min(100, (r.spent / r.budget) * 100) : 0;
  const sub = r.budget > 0
    ? (r.remaining >= 0 ? `reste ${money(r.remaining)}` : `<span class="ko">dépassé de ${money(-r.remaining)}</span>`)
    : 'sans budget';
  return `
  <button class="cat-row" data-act="toggle-cat" data-id="${esc(c.id)}" aria-expanded="${open}">
    <span class="ico">${esc(c.icon)}</span>
    <span class="cat-main">
      <span class="cat-name">${esc(c.name)}${c.archived ? ' <small class="muted">(archivée)</small>' : ''}</span>
      ${r.budget > 0 ? `<span class="bar"><i class="${r.over ? 'over' : (pct >= 85 && c.kind === 'variable') ? 'warn' : ''}" style="width:${pct}%"></i></span>` : ''}
    </span>
    <span class="cat-nums"><b>${money(r.spent)}</b>${r.budget > 0 ? `<small>sur ${money(r.budget)}</small>` : ''}<small>${sub}</small></span>
  </button>
  ${open ? `<div class="tx-list">${r.tx.length ? r.tx.map(txRow).join('') : '<p class="note pad">Aucune dépense.</p>'}
     <button class="add-inline" data-act="add-in-cat" data-id="${esc(c.id)}">+ Ajouter dans ${esc(c.name)}</button></div>` : ''}`;
}

function txRow(t) {
  const c = t.category_id && catById(t.category_id);
  const title = t.label || t.merchant || (c ? c.name : (t.kind === 'revenu' ? 'Rentrée d’argent' : 'Dépense'));
  const badges = [
    t.pending && 'en attente',
    t.source === 'raccourci' && 'iPhone',
    t.source === 'fixe' && 'auto',
    t.source === 'import' && (t.bank || 'relevé'),
    t.part && `lissé ${t.part}`,
    t.reimbursable && !t.reimbursed_at && 'à rembourser',
  ].filter(Boolean).map((b) => `<span class="badge">${esc(b)}</span>`).join('');
  const shown = t.share !== undefined && t.share !== null ? t.share : t.amount;
  return `<button class="tx" data-act="edit-tx" data-id="${esc(t.id)}">
    <span class="tx-date">${esc(C.dayLabel(t.date))}</span>
    <span class="tx-label">${esc(title)} ${badges}</span>
    <b>${t.kind === 'revenu' ? '+' : ''}${money(shown)}${t.part ? `<small class="muted"> / ${money(t.amount)}</small>` : ''}</b></button>`;
}

// ── Écran : Projets ─────────────────────────────────────────────────────────
function monthOptions(selected, { allowEmpty = true } = {}) {
  const now = C.monthKey();
  let html = allowEmpty ? `<option value="">—</option>` : '';
  for (let i = -24; i <= 96; i++) {
    const m = C.addMonths(now, i);
    html += `<option value="${m}" ${m === selected ? 'selected' : ''}>${esc(C.monthLabel(m, { short: true }))}</option>`;
  }
  return html;
}

function viewProjects() {
  const g = goal();
  const st = S.data.settings;
  const projects = [...S.data.projects].sort((a, b) => a.position - b.position);
  return `
  <header class="top"><h1>Projets</h1></header>
  <section class="hero">
    <div class="hero-label">Déjà épargné pour mes projets</div>
    <div class="hero-amount">${money(g.saved)}</div>
    <div class="hero-goal">sur ${money(g.cost)} · ${Math.round(g.progress * 100)} %</div>
    <div class="bar light"><i style="width:${g.progress * 100}%"></i></div>
    ${g.configured
      ? `<p class="hero-free">Reste <b>${money(g.remaining)}</b> à financer en ${g.monthsLeft} mois : <b>${money(g.monthly)} / mois</b>.</p>`
      : '<p class="hero-free">Indique un coût et une date de fin pour calculer ton objectif mensuel.</p>'}
  </section>

  <section class="card form">
    <label>Coût total des projets
      <input data-set="projects_total" data-type="money" inputmode="decimal" value="${inputNum(st.projects_total)}"
        ${g.allPriced ? 'disabled' : ''} placeholder="0,00">
    </label>
    ${g.allPriced ? '<p class="note">Calculé automatiquement : tous tes projets ont un prix.</p>' : ''}
    <div class="two">
      <label>À partir de<select data-set="goal_start">${monthOptions(st.goal_start)}</select></label>
      <label>Jusqu’à<select data-set="goal_end">${monthOptions(st.goal_end)}</select></label>
    </div>
    <p class="note">L’épargne réelle de chaque mois terminé (revenus − dépenses) compte comme épargnée pour tes projets.</p>
  </section>

  <h2>Mes projets <span class="muted">${g.pricedCount}/${g.projectCount} avec prix</span></h2>
  <div class="card list">
    ${projects.map((p) => `
      <div class="proj ${p.bought ? 'done' : ''}">
        <button class="check" data-act="proj-toggle" data-id="${esc(p.id)}" aria-label="${p.bought ? 'Marquer comme à acheter' : 'Marquer comme acheté'}" aria-pressed="${p.bought}">${p.bought ? '✓' : ''}</button>
        <input class="grow" data-proj="name" data-id="${esc(p.id)}" value="${esc(p.name)}" aria-label="Nom du projet">
        <input class="price" data-proj="price" data-type="money-null" data-id="${esc(p.id)}" inputmode="decimal" value="${inputNum(p.price)}" placeholder="Prix" aria-label="Prix">
        <button class="icon-btn small" data-act="proj-del" data-id="${esc(p.id)}" aria-label="Supprimer">✕</button>
      </div>`).join('') || '<p class="note pad">Aucun projet pour l’instant.</p>'}
    <form class="proj add" data-form="proj-add">
      <input class="grow" name="name" placeholder="Nouveau projet" maxlength="60" required>
      <input class="price" name="price" inputmode="decimal" placeholder="Prix">
      <button class="btn small">Ajouter</button>
    </form>
  </div>
  <div class="fab-space"></div>`;
}

// ── Écran : Comptes ─────────────────────────────────────────────────────────
function viewAccounts() {
  const accounts = [...S.data.accounts].sort((a, b) => a.position - b.position);
  const total = C.round2(accounts.reduce((s, a) => s + Number(a.balance || 0), 0));
  const saving = C.round2(accounts.filter((a) => a.kind !== 'courant').reduce((s, a) => s + Number(a.balance || 0), 0));
  const yearly = C.round2(accounts.reduce((s, a) => s + Number(a.balance || 0) * Number(a.rate || 0) / 100, 0));
  return `
  <header class="top"><h1>Comptes</h1></header>
  <section class="hero">
    <div class="hero-label">Total de mes comptes</div>
    <div class="hero-amount">${money(total)}</div>
    <div class="hero-goal">dont épargne ${money(saving)}${yearly ? ` · ≈ ${money(yearly)} d’intérêts par an` : ''}</div>
  </section>
  <div class="card list">
    ${accounts.map((a) => {
      const [ico, kind] = KINDS[a.kind] || KINDS.autre;
      return `<button class="cat-row" data-act="acc-edit" data-id="${esc(a.id)}">
        <span class="ico">${ico}</span>
        <span class="cat-main"><span class="cat-name">${esc(a.name)}</span>
          <small class="muted">${esc(kind)}${Number(a.rate) ? ` · ${esc(String(a.rate).replace('.', ','))} %` : ''} · mis à jour le ${esc(new Date(a.updated_at || Date.now()).toLocaleDateString('fr-FR'))}</small></span>
        <span class="cat-nums"><b>${money(a.balance)}</b></span></button>`;
    }).join('') || '<p class="note pad">Ajoute ton Livret A, ton PEL, ton compte courant… pour suivre ton patrimoine.</p>'}
  </div>
  <button class="btn block" data-act="acc-add">+ Ajouter un compte</button>
  <p class="note">Mets tes soldes à jour de temps en temps : ils servent de point de départ aux simulations.</p>
  <div class="fab-space"></div>`;
}

// ── Écran : Simulations ─────────────────────────────────────────────────────
function simDefaults() {
  const g = goal();
  const livret = S.data.accounts.find((a) => a.kind === 'livret');
  return {
    epargne: { initial: livret ? Number(livret.balance) : 0, monthly: g.monthly || 200, rate: livret ? Number(livret.rate) : 1.7, years: 1 },
    pret: { principal: 10000, rate: 4, years: 5, insurance: 0.3, income: usualIncome(), other: 0 },
    objectif: { target: g.cost || 1000, current: g.saved || 0, monthly: g.monthly || 200 },
  };
}
const simVal = (tab, k) => {
  const v = S.sim[tab]?.[k];
  return v === undefined ? simDefaults()[tab][k] : v;
};

function viewSims() {
  const t = S.sim.tab;
  const field = (k, label, suffix, attrs = '') => `<label>${label}
    <span class="suffix" style="--w:${suffix.length}ch"><input data-sim="${k}" inputmode="decimal" value="${inputNum(simVal(t, k))}" ${attrs}><i>${suffix}</i></span></label>`;
  let form = '';
  if (t === 'epargne') {
    form = `${field('initial', 'Montant de départ', '€')}
      ${S.data.accounts.length ? `<div class="chips">${S.data.accounts.map((a) => `<button class="chip" data-act="sim-from-acc" data-id="${esc(a.id)}">${esc(a.name)}</button>`).join('')}</div>` : ''}
      ${field('monthly', 'Je mets de côté chaque mois', '€')}
      <div class="two">${field('rate', 'Taux', '%')}${field('years', 'Pendant', 'ans')}</div>`;
  } else if (t === 'pret') {
    form = `${field('principal', 'Montant emprunté', '€')}
      <div class="two">${field('rate', 'Taux (TAEG hors ass.)', '%')}${field('years', 'Durée', 'ans')}</div>
      <div class="two">${field('insurance', 'Assurance / an', '%')}${field('other', 'Autres crédits', '€/mois')}</div>
      ${field('income', 'Mes revenus mensuels', '€')}`;
  } else {
    form = `${field('target', 'Montant à atteindre', '€')}
      ${field('current', 'Déjà épargné', '€')}
      ${field('monthly', 'Je mets de côté chaque mois', '€')}`;
  }
  return `
  <header class="top"><h1>Simulations</h1></header>
  <div class="seg" role="tablist">
    ${[['epargne', 'Épargne'], ['pret', 'Prêt'], ['objectif', 'Objectif']].map(([k, l]) =>
      `<button role="tab" aria-selected="${t === k}" data-act="sim-tab" data-tab="${k}">${l}</button>`).join('')}
  </div>
  <section class="card form">${form}
    <button class="link small" data-act="sim-reset">Revenir aux valeurs de départ</button></section>
  <div id="sim-out"></div>
  <div class="fab-space"></div>`;
}

function renderSim() {
  const out = $('#sim-out');
  if (!out) return;
  const t = S.sim.tab;
  const v = (k) => Number(C.parseAmount(simVal(t, k)) ?? 0);
  const neg = (k) => { const raw = String(simVal(t, k) ?? ''); return raw.trim().startsWith('-') ? -v(k) : v(k); };
  const fixed = fixedBudgets();
  const income = usualIncome();

  if (t === 'epargne') {
    const months = Math.max(1, Math.round(v('years') * 12));
    const r = C.simulateSavings({ initial: v('initial'), monthly: v('monthly'), ratePct: v('rate'), months, startMonth: C.addMonths(C.monthKey(), 1) });
    const left = C.round2(income - fixed - v('monthly'));
    out.innerHTML = `
      <section class="card result">
        <div class="big">${money(r.final)}</div>
        <p class="muted">dans ${months} mois (${esc(C.monthLabel(C.addMonths(C.monthKey(), months)))})</p>
        <div class="kv"><span>Tes versements</span><b>${money(r.contributions)}</b></div>
        <div class="kv"><span>Intérêts gagnés</span><b class="ok">+&nbsp;${money(r.interest)}</b></div>
        ${chart(r.series)}
        <p class="note">Intérêts calculés comme sur un livret : versés chaque 31 décembre.</p>
      </section>
      ${income ? `<section class="card result">
        <div class="kv"><span>Revenus habituels</span><b>${money(income)}</b></div>
        <div class="kv"><span>Charges fixes et épargne auto</span><b>−&nbsp;${money(fixed)}</b></div>
        <div class="kv"><span>Cette épargne</span><b>−&nbsp;${money(v('monthly'))}</b></div>
        <div class="kv total"><span>Il te reste pour vivre</span><b class="${left < 0 ? 'ko' : ''}">${money(left)} / mois</b></div>
      </section>` : '<p class="note">Renseigne tes revenus habituels dans Réglages pour voir ce qu’il te reste pour vivre.</p>'}`;
  } else if (t === 'pret') {
    const months = Math.max(1, Math.round(v('years') * 12));
    const r = C.simulateLoan({ principal: v('principal'), ratePct: neg('rate'), months, insuranceRatePct: v('insurance'), income: v('income'), otherDebts: v('other') });
    const cap = C.borrowingCapacity({ income: v('income'), otherDebts: v('other'), ratePct: neg('rate'), months, insuranceRatePct: v('insurance') });
    const ratio = r.debtRatio;
    const left = C.round2(v('income') - fixed - r.monthlyTotal - v('other'));
    out.innerHTML = `
      <section class="card result">
        <div class="big">${money(r.monthlyTotal)} <small>/ mois</small></div>
        <p class="muted">pendant ${months} mois${r.insurance ? ` · dont assurance ${money(r.insurance)}` : ''}</p>
        <div class="kv"><span>Intérêts</span><b>${money(r.totalInterest)}</b></div>
        ${r.totalInsurance ? `<div class="kv"><span>Assurance</span><b>${money(r.totalInsurance)}</b></div>` : ''}
        <div class="kv total"><span>Coût total du crédit</span><b>${money(r.totalCost)}</b></div>
      </section>
      ${ratio !== null ? `<section class="card result">
        <div class="kv"><span>Taux d’endettement</span><b class="${ratio > 0.35 ? 'ko' : 'ok'}">${esc(C.percent(ratio))}</b></div>
        <div class="gauge"><i style="width:${Math.min(100, ratio / 0.5 * 100)}%" class="${ratio > 0.35 ? 'over' : ''}"></i><em style="left:70%"></em></div>
        <p class="note">${ratio > 0.35
          ? 'Au-dessus de 35 % (assurance comprise), la plupart des banques refusent : c’est la règle du HCSF.'
          : 'Sous le plafond de 35 % (assurance comprise) appliqué par les banques (règle du HCSF).'}</p>
        <div class="kv"><span>Emprunt max. sur ${months} mois à ce taux</span><b>${money(cap.principal)}</b></div>
        <div class="kv total"><span>Reste pour vivre après charges fixes</span><b class="${left < 0 ? 'ko' : ''}">${money(left)} / mois</b></div>
      </section>` : ''}
      <details class="card result"><summary>Tableau par année</summary>
        <table class="amort"><thead><tr><th>Année</th><th>Capital</th><th>Intérêts</th><th>Reste dû</th></tr></thead>
        <tbody>${r.years.map((y) => `<tr><td>${y.year}</td><td>${money(y.principal)}</td><td>${money(y.interest)}</td><td>${money(y.remaining)}</td></tr>`).join('')}</tbody></table>
      </details>
      <p class="note">Simulation indicative : les banques ajoutent souvent des frais de dossier et de garantie.</p>`;
  } else {
    const n = C.monthsToReach({ target: v('target'), current: v('current'), monthly: v('monthly') });
    const end = S.data.settings?.goal_end;
    const need = end ? C.round2(Math.max(0, v('target') - v('current')) / Math.max(1, C.monthsBetween(C.monthKey(), end))) : null;
    out.innerHTML = `
      <section class="card result">
        ${n === 0 ? '<div class="big ok">Objectif déjà atteint</div>'
          : n === Infinity ? '<div class="big">—</div><p class="muted">Indique un montant mensuel.</p>'
            : `<div class="big">${n} mois</div><p class="muted">tu y es en <b>${esc(C.monthLabel(C.addMonths(C.monthKey(), n - 1)))}</b></p>`}
        ${need !== null ? `<div class="kv total"><span>Pour finir en ${esc(C.monthLabel(end))}</span><b>${money(need)} / mois</b></div>` : ''}
        ${usualIncome() ? `<div class="kv"><span>Reste pour vivre avec ${money(v('monthly'))} / mois</span><b>${money(usualIncome() - fixedBudgets() - v('monthly'))}</b></div>` : ''}
      </section>`;
  }
}

function chart(series) {
  if (series.length < 2) return '';
  const w = 320; const h = 120; const p = 6;
  const vals = series.map((s) => s.balance);
  const max = Math.max(...vals, 1); const min = Math.min(0, ...vals);
  const x = (i) => p + (i * (w - 2 * p)) / (vals.length - 1);
  const y = (v) => h - p - ((v - min) / (max - min || 1)) * (h - 2 * p);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Évolution du solde">
    <path d="${line}L${x(vals.length - 1)},${h - p}L${p},${h - p}Z" class="area"/>
    <path d="${line}" class="line"/></svg>`;
}

// ── Écran : Réglages ────────────────────────────────────────────────────────
function viewSettings() {
  const st = S.data.settings;
  const cats = [...S.data.categories].sort((a, b) => a.position - b.position);
  const fixed = S.data.fixed_charges;
  const cloud = S.store.mode === 'cloud';
  const endpoint = cloud ? `${S.store.url}/rest/v1/rpc/add_from_shortcut` : '';
  const catOptions = (sel) => activeCats().map((c) => `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('');
  return `
  <header class="top"><h1>Réglages</h1></header>

  <h2>Revenus et mois de budget</h2>
  <section class="card form">
    <label>Mon salaire habituel, par mois
      <span class="suffix"><input data-set="default_income" data-type="money" inputmode="decimal" value="${inputNum(st.default_income)}"><i>€</i></span></label>
    <label>Il arrive en général le
      <span class="suffix" style="--w:9ch"><input data-set="pay_day" data-type="day31" inputmode="numeric" value="${esc(st.pay_day || 1)}"><i>du mois</i></span></label>
    <p class="note">Ton mois de budget va d’une paie à la suivante (en ce moment : ${esc(C.rangeLabel(C.periodRange(currentKey(), S.data.months, payDay())))}). Quand ton salaire arrive un autre jour, touche « Salaire reçu » sur l’accueil ou importe ton relevé : le mois démarre au bon jour.</p>
    <label>Mon nom tel qu’il apparaît sur mes relevés
      <input data-set="owner_names" value="${esc(st.owner_names || '')}" placeholder="ex. DUPONT ALEX" maxlength="120"></label>
    <p class="note">Sert à reconnaître tes virements entre tes propres comptes, qui ne sont ni des dépenses ni des revenus. Plusieurs noms : sépare-les par des virgules.</p>
  </section>

  <h2>Relevés bancaires</h2>
  <section class="card form">
    <button class="btn" data-act="statement-pick">📄 Importer un relevé (PDF ou CSV)</button>
    <input type="file" id="statement-file" accept=".pdf,.csv,application/pdf,text/csv" hidden>
    <p class="note">Relevé mensuel en PDF (LCL…) ou export CSV. Les paiements déjà ajoutés par l’iPhone ne sont pas comptés deux fois.</p>
  </section>

  <h2>Catégories et budgets</h2>
  <div class="card list">
    ${cats.map((c, i) => `
    <div class="cat-edit ${c.archived ? 'archived' : ''}">
      <input class="emoji" data-cat="icon" data-id="${esc(c.id)}" value="${esc(c.icon)}" maxlength="4" aria-label="Icône">
      <input class="grow" data-cat="name" data-id="${esc(c.id)}" value="${esc(c.name)}" maxlength="40" aria-label="Nom">
      <select data-cat="kind" data-id="${esc(c.id)}" aria-label="Type">${Object.entries(CAT_KINDS).map(([k, l]) => `<option value="${k}" ${c.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="suffix budget"><input data-cat="budget" data-type="money" data-id="${esc(c.id)}" inputmode="decimal" value="${inputNum(c.budget)}" placeholder="0" aria-label="Budget mensuel"><i>€</i></span>
      <span class="order">
        <button class="icon-btn small" data-act="cat-move" data-id="${esc(c.id)}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Monter">↑</button>
        <button class="icon-btn small" data-act="cat-archive" data-id="${esc(c.id)}" aria-label="${c.archived ? 'Réactiver' : 'Archiver'}">${c.archived ? '↺' : '✕'}</button>
      </span>
    </div>`).join('')}
    <form class="cat-edit add" data-form="cat-add">
      <input class="emoji" name="icon" value="📦" maxlength="4" aria-label="Icône">
      <input class="grow" name="name" placeholder="Nouvelle catégorie" maxlength="40" required>
      <button class="btn small">Ajouter</button>
    </form>
  </div>
  <p class="note">« Chaque mois » et « Épargne » sont regroupées en haut de l’écran du mois. Une catégorie archivée disparaît des choix mais garde son historique.</p>

  <h2>Charges fixes automatiques</h2>
  <div class="card list">
    ${fixed.map((f) => `
    <div class="fix-edit">
      <input class="grow" data-fix="label" data-id="${esc(f.id)}" value="${esc(f.label)}" maxlength="60" aria-label="Libellé">
      <span class="suffix"><input data-fix="amount" data-type="money" data-id="${esc(f.id)}" inputmode="decimal" value="${inputNum(f.amount)}" aria-label="Montant"><i>€</i></span>
      <label class="day">le <input data-fix="day" data-type="int" data-id="${esc(f.id)}" inputmode="numeric" value="${f.day}" aria-label="Jour du mois"></label>
      <select data-fix="category_id" data-id="${esc(f.id)}" aria-label="Catégorie">${catOptions(f.category_id)}</select>
      <button class="icon-btn small" data-act="fix-del" data-id="${esc(f.id)}" aria-label="Supprimer">✕</button>
    </div>`).join('') || '<p class="note pad">Aucune. Exemple : loyer 610 € le 1er.</p>'}
    <form class="fix-edit add" data-form="fix-add">
      <input class="grow" name="label" placeholder="Libellé (ex. Loyer)" maxlength="60" required>
      <span class="suffix"><input name="amount" inputmode="decimal" placeholder="0" required><i>€</i></span>
      <label class="day">le <input name="day" inputmode="numeric" value="1"></label>
      <select name="category_id">${catOptions(null)}</select>
      <button class="btn small">Ajouter</button>
    </form>
  </div>
  <p class="note">Elles s’ajoutent toutes seules chaque mois, au jour indiqué (1 à 28). Pour sauter un mois, mets la dépense créée à 0 €.</p>

  <h2>Commerçants retenus <span class="muted">${S.data.merchant_rules.length}</span></h2>
  <div class="card list">
    ${S.data.merchant_rules.length ? [...S.data.merchant_rules].sort((a, b) => a.merchant.localeCompare(b.merchant)).map((r) => {
      const c = r.category_id && catById(r.category_id);
      const what = r.action === 'ignorer' ? 'toujours ignoré' : r.action === 'rembourse' ? 'remboursement attendu' : c ? `${c.icon} ${c.name}` : '—';
      return `<div class="rule-row"><span class="grow">${esc(r.merchant)}</span><span class="muted">${esc(what)}</span>
        <button class="icon-btn small" data-act="rule-del" data-key="${esc(r.merchant)}" aria-label="Oublier">✕</button></div>`;
    }).join('') : '<p class="note pad">L’app retient un commerçant dès que tu classes une de ses dépenses.</p>'}
  </div>

  <h2>Raccourci iPhone (paiements Apple Pay)</h2>
  <section class="card form">
    ${cloud ? `
    <p>Chaque paiement sans contact avec ton iPhone peut s’ajouter tout seul ici. Les commerçants déjà classés vont directement dans la bonne catégorie ; les autres arrivent dans « À classer ».</p>
    <div class="copy-row"><span>Adresse</span><code>${esc(endpoint)}</code><button class="btn small" data-act="copy" data-value="${esc(endpoint)}">Copier</button></div>
    <div class="copy-row"><span>Clé (apikey)</span><code>${esc(S.store.key.slice(0, 18))}…</code><button class="btn small" data-act="copy" data-value="${esc(S.store.key)}">Copier</button></div>
    <div class="copy-row"><span>Mon jeton</span><code>${esc(st.shortcut_token.slice(0, 10))}…</code><button class="btn small" data-act="copy" data-value="${esc(st.shortcut_token)}">Copier</button></div>
    <details><summary>Installer le raccourci (5 minutes)</summary>
      <ol class="steps">
        <li>Ouvre l’app <b>Raccourcis</b> → onglet <b>Automatisation</b> → <b>+</b> → <b>Transaction</b>.</li>
        <li>Choisis ta ou tes cartes, laisse toutes les catégories cochées, sélectionne <b>Exécuter immédiatement</b>, puis <b>Suivant</b> → <b>Nouveau raccourci vide</b>.</li>
        <li>Ajoute l’action <b>Obtenir le contenu de l’URL</b> et colle l’<b>adresse</b> ci-dessus.</li>
        <li>Touche la flèche de l’action : <b>Méthode</b> = POST. <b>En-têtes</b> : ajoute <code>apikey</code> avec la <b>clé</b> copiée.</li>
        <li><b>Corps de la requête</b> = JSON, ajoute trois champs Texte :<br>
          <code>p_token</code> → colle ton <b>jeton</b><br>
          <code>p_amount</code> → variable <b>Montant</b> (Entrée du raccourci)<br>
          <code>p_merchant</code> → variable <b>Commerçant</b></li>
        <li>Ajoute <b>Obtenir la valeur du dictionnaire</b> : clé <code>message</code>, dans <b>Contenu de l’URL</b>.</li>
        <li>Ajoute <b>Afficher la notification</b> avec la <b>Valeur du dictionnaire</b>. Tu verras par exemple « 18,00 € → Bar / resto · il te reste 140,00 € ce mois-ci ».</li>
      </ol>
      <p class="note">Fonctionne pour les paiements Apple Pay sans contact, pas pour les achats en ligne. Si ton iPhone est en anglais, les variables s’appellent « Amount » et « Merchant ».</p>
    </details>
    <button class="link small" data-act="token-reset">Changer mon jeton (l’ancien raccourci arrêtera de marcher)</button>`
    : '<p class="note">Disponible avec un compte en ligne : en mode local, les données restent sur cet appareil.</p>'}
  </section>

  <h2>Sauvegarde</h2>
  <section class="card form">
    <div class="two">
      <button class="btn" data-act="export">Exporter mes données</button>
      <button class="btn ghost" data-act="import-pick">Importer une sauvegarde</button>
    </div>
    <p class="note">L’import remplace toutes les données de ce compte.</p>
  </section>

  <h2>Compte</h2>
  <section class="card form">
    <p>${cloud ? `Connecté : <b>${esc(S.user.email)}</b>` : 'Mode local : les données restent dans ce navigateur.'}</p>
    <p class="sync-status">${cloud
      ? (S.sync === 'live' ? '<span class="dot ok"></span>Synchronisation en direct avec tes autres appareils'
        : S.sync === 'error' ? '<span class="dot ko"></span>Synchronisation interrompue : elle reprend quand tu reviens sur l’app'
          : '<span class="dot"></span>Connexion à la synchronisation…')
      : '<span class="dot"></span>Pas de synchronisation entre appareils en mode local'}</p>
    <div class="two">
      <button class="btn ghost" data-act="logout">${cloud ? 'Se déconnecter' : 'Quitter le mode local'}</button>
      <button class="btn danger" data-act="delete-account">Supprimer mon compte</button>
    </div>
  </section>
  <input type="file" id="import-file" accept="application/json,.json" hidden>
  <p class="note center-text">Mon Budget ${VERSION}</p>
  <div class="fab-space"></div>`;
}

// ── Écrans hors app ─────────────────────────────────────────────────────────
function viewConfig() {
  return `<div class="auth">
    <div class="logo">€</div><h1>Mon Budget</h1>
    <p class="muted">Pour synchroniser tes appareils, connecte l’app à ta base Supabase (voir le guide d’installation).</p>
    <form class="card form" data-form="config">
      <label>Project URL<input name="url" type="url" placeholder="https://xxxx.supabase.co" required autocomplete="off"></label>
      <label>Clé publishable (ou anon)<input name="key" required autocomplete="off"></label>
      <button class="btn primary block">Enregistrer</button>
    </form>
    <button class="btn ghost block" data-act="local-mode">Essayer sans compte (sur cet appareil)</button>
  </div>`;
}

function viewAuth() {
  const m = S.authMode;
  const msg = S.authMsg ? `<p class="${S.authMsg.ok ? 'okmsg' : 'err'}">${esc(S.authMsg.text)}</p>` : '';
  const forms = {
    login: `<form class="card form" data-form="login">
        <label>Email<input name="email" type="email" autocomplete="email" required></label>
        <label>Mot de passe<input name="password" type="password" autocomplete="current-password" required></label>
        ${msg}<button class="btn primary block" ${S.busy ? 'disabled' : ''}>Se connecter</button></form>
      <div class="auth-links"><button class="link" data-act="auth-mode" data-mode="signup">Créer un compte</button>
      <button class="link" data-act="auth-mode" data-mode="forgot">Mot de passe oublié ?</button></div>`,
    signup: `<form class="card form" data-form="signup">
        <label>Email<input name="email" type="email" autocomplete="email" required></label>
        <label>Mot de passe (8 caractères min.)<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
        ${msg}<button class="btn primary block" ${S.busy ? 'disabled' : ''}>Créer mon compte</button></form>
      <div class="auth-links"><button class="link" data-act="auth-mode" data-mode="login">J’ai déjà un compte</button></div>`,
    forgot: `<form class="card form" data-form="forgot">
        <label>Email<input name="email" type="email" autocomplete="email" required></label>
        ${msg}<button class="btn primary block" ${S.busy ? 'disabled' : ''}>Recevoir un lien</button></form>
      <div class="auth-links"><button class="link" data-act="auth-mode" data-mode="login">Retour</button></div>`,
  };
  return `<div class="auth">
    <div class="logo">€</div><h1>Mon Budget</h1>
    <p class="muted">Tes dépenses, tes budgets et ton épargne, sur tous tes appareils.</p>
    ${forms[m] || forms.login}
  </div>`;
}

// ── Assistant de démarrage ──────────────────────────────────────────────────
const WIZ_STEPS = ['Bienvenue', 'Revenus', 'Charges fixes', 'Budgets', 'Épargne', 'C’est prêt'];
const FIXED_CATS = ['Loyer', 'Abonnements', 'Assurances', 'Crédit / prêt', 'Épargne auto'];
const VAR_CATS = C.DEFAULT_CATEGORIES.filter((c) => c.kind === 'variable').map((c) => c.name);

function newWizard() {
  return {
    step: 0, income: '', payDay: '1', name: '',
    fixed: [{ label: 'Loyer', amount: '', day: '1', cat: 'Loyer' }, { label: 'Téléphone', amount: '', day: '1', cat: 'Abonnements' }],
    budgets: {}, total: '', end: '',
  };
}

function viewWelcome() {
  const w = S.wiz || (S.wiz = newWizard());
  const nav = (next = 'Continuer', skip = true) => `<div class="wiz-nav">
    ${w.step > 0 ? '<button class="btn ghost" data-act="wiz-back">Retour</button>' : '<span></span>'}
    ${skip && w.step > 0 && w.step < 5 ? '<button class="link" data-act="wiz-next" data-skip="1">Passer</button>' : ''}
    <button class="btn primary" data-act="wiz-next">${next}</button></div>`;
  const dots = `<div class="wiz-dots">${WIZ_STEPS.map((s, i) => `<i class="${i === w.step ? 'on' : i < w.step ? 'done' : ''}" title="${esc(s)}"></i>`).join('')}</div>`;
  const inp = (field, value, attrs = '') => `<input data-wiz="${field}" value="${esc(value)}" ${attrs}>`;
  let body = '';
  if (w.step === 0) {
    body = `<div class="logo">€</div><h1>Bienvenue</h1>
      <p class="muted">En 4 petites étapes, on règle ton budget : revenus, charges fixes, budgets par catégorie et épargne. Tu pourras tout modifier ensuite.</p>
      ${nav('Commencer', false)}
      <button class="btn ghost block" data-act="import-pick">J’ai une sauvegarde à importer</button>
      <input type="file" id="import-file" accept="application/json,.json" hidden>`;
  } else if (w.step === 1) {
    body = `<h1>Tes revenus</h1>
      <section class="card form">
        <label>Combien gagnes-tu par mois (salaire net) ?<span class="suffix">${inp('income', w.income, 'inputmode="decimal" placeholder="1 700"')}<i>€</i></span></label>
        <label>Ton salaire arrive vers le…<span class="suffix" style="--w:9ch">${inp('payDay', w.payDay, 'inputmode="numeric"')}<i>du mois</i></span></label>
        <p class="note">Ton mois de budget ira d’une paie à la suivante. Salaire le 26 ? Ton budget de septembre ira du 26 août au 25 septembre.</p>
        <label>Ton nom tel qu’il apparaît sur tes relevés (facultatif)${inp('name', w.name, 'placeholder="ex. DUPONT ALEX" maxlength="120"')}</label>
        <p class="note">Pour reconnaître tes virements entre tes propres comptes.</p>
      </section>${nav()}`;
  } else if (w.step === 2) {
    body = `<h1>Tes charges fixes</h1>
      <p class="muted">Ce qui part chaque mois quoi qu’il arrive. Elles seront ajoutées toutes seules.</p>
      <div class="card list">
        ${w.fixed.map((f, i) => `<div class="fix-edit">
          ${inp(`fixed.${i}.label`, f.label, 'class="grow" placeholder="Libellé" maxlength="60"')}
          <span class="suffix">${inp(`fixed.${i}.amount`, f.amount, 'inputmode="decimal" placeholder="0"')}<i>€</i></span>
          <label class="day">le ${inp(`fixed.${i}.day`, f.day, 'inputmode="numeric"')}</label>
          <select data-wiz="fixed.${i}.cat">${FIXED_CATS.map((c) => `<option ${c === f.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <button class="icon-btn small" data-act="wiz-del-fixed" data-i="${i}" aria-label="Retirer">✕</button></div>`).join('')}
      </div>
      <button class="btn ghost block" data-act="wiz-add-fixed">+ Ajouter une charge (assurance, crédit, abonnement…)</button>
      ${nav()}`;
  } else if (w.step === 3) {
    body = `<h1>Tes budgets</h1>
      <p class="muted">Combien veux-tu t’autoriser chaque mois ? Laisse vide si tu ne veux pas de limite.</p>
      <div class="card list">
        ${VAR_CATS.map((name) => {
          const c = C.DEFAULT_CATEGORIES.find((x) => x.name === name);
          return `<div class="cat-edit"><span class="ico">${esc(c.icon)}</span><span class="grow">${esc(name)}</span>
            <span class="suffix budget">${inp(`budgets.${name}`, w.budgets[name] || '', 'inputmode="decimal" placeholder="—"')}<i>€</i></span></div>`;
        }).join('')}
      </div>${nav()}`;
  } else if (w.step === 4) {
    body = `<h1>Ton épargne</h1>
      <p class="muted">Tu mets de l’argent de côté pour des projets (voyage, vélo, formation…) ? L’app calcule combien épargner chaque mois et le retire de ton budget.</p>
      <section class="card form">
        <label>Coût total de tes projets<span class="suffix">${inp('total', w.total, 'inputmode="decimal" placeholder="0"')}<i>€</i></span></label>
        <label>À réunir avant<select data-wiz="end">${monthOptions(w.end)}</select></label>
        <p class="note">Tu pourras détailler tes projets un par un dans l’onglet Projets.</p>
      </section>${nav()}`;
  } else {
    const inc = C.parseAmount(w.income) || 0;
    const fixed = w.fixed.reduce((s, f) => s + (C.parseAmount(f.amount) || 0), 0);
    const total = C.parseAmount(w.total) || 0;
    const months = w.end ? C.monthsBetween(C.periodOf(C.dateKey(), [], Math.min(31, Math.max(1, parseInt(w.payDay, 10) || 1))), w.end) : 0;
    const goalM = months > 0 ? C.round2(total / months) : 0;
    body = `<h1>C’est prêt</h1>
      <section class="card result">
        <div class="kv"><span>Revenus</span><b>${money(inc)}</b></div>
        <div class="kv"><span>Charges fixes</span><b>− ${money(fixed)}</b></div>
        ${goalM ? `<div class="kv"><span>Épargne pour tes projets</span><b>− ${money(goalM)}</b></div>` : ''}
        <div class="kv total"><span>Pour vivre chaque mois</span><b>${money(inc - fixed - goalM)}</b></div>
      </section>
      <p class="note">Dernière étape conseillée : le raccourci iPhone, pour que tes paiements sans contact s’ajoutent tout seuls. Tu le trouveras dans Réglages.</p>
      ${nav('C’est parti !', false)}`;
  }
  return `<div class="wizard">${dots}${body}</div>`;
}

async function finishWizard() {
  const w = S.wiz;
  const month = C.monthKey();
  const pd = Math.min(31, Math.max(1, parseInt(w.payDay, 10) || 1));
  const cats = C.DEFAULT_CATEGORIES.map((c, i) => ({ ...c, id: newId(), position: i, budget: 0 }));
  const byName = Object.fromEntries(cats.map((c) => [c.name, c]));
  const fixed = w.fixed.filter((f) => f.label.trim() && C.parseAmount(f.amount)).map((f) => ({
    id: newId(), label: f.label.trim(), amount: C.parseAmount(f.amount),
    day: Math.min(28, Math.max(1, parseInt(f.day, 10) || 1)), category_id: (byName[f.cat] || byName.Loyer).id,
  }));
  for (const f of fixed) { const c = cats.find((x) => x.id === f.category_id); c.budget = C.round2(c.budget + f.amount); }
  for (const [name, v] of Object.entries(w.budgets)) if (byName[name]) byName[name].budget = C.parseAmount(v) || 0;
  S.screen = 'loading'; render();
  await S.store.upsert('settings', [{
    default_income: C.parseAmount(w.income) || 0, pay_day: pd, owner_names: w.name.trim() || null,
    projects_total: C.parseAmount(w.total) || 0, goal_start: C.periodOf(C.dateKey(), [], pd), goal_end: w.end || null,
  }]);
  await S.store.insert('categories', cats);
  if (fixed.length) await S.store.insert('fixed_charges', fixed);
  S.wiz = null;
  S.month = null;
  await loadData();
  if (month) toast('Ton budget est prêt', 'ok');
}

// ── Import d'un relevé : vérification avant d'enregistrer ───────────────────
async function startImport(file) {
  toast('Lecture du relevé…');
  let res;
  try { res = await B.readStatement(file); } catch (e) { toast(e.message || 'Relevé illisible', 'error'); return; }
  const ids = B.externalIds(res.bank.id, res.ops);
  const known = new Set(S.data.transactions.map((t) => t.external_id).filter(Boolean));
  const used = new Set();
  const pendingR = C.pendingRefunds(S.data.transactions);
  const rows = res.ops.map((op, i) => {
    const row = { i, op, ext: ids[i], status: 'new', dupId: null };
    if (known.has(ids[i])) row.status = 'already';
    else {
      const d = B.findDuplicate(op, S.data.transactions, used);
      if (d) { used.add(d.id); row.status = 'dup'; row.dupId = d.id; }
    }
    return row;
  });
  S.imp = { file: file.name, bank: res.bank, period: res.period, closing: res.closing, rows, pendingR, updateBalance: res.closing !== null };
  classifyImport();
  S.sheet = null;
  render();
  $('#toast').className = '';          // « Lecture du relevé… » n'a plus lieu d'être
  scrollTo(0, 0);
}

function classifyImport() {
  const ctx = { categories: S.data.categories, rules: S.data.merchant_rules, ownerNames: ownerNames(), defaultIncome: usualIncome() };
  for (const r of S.imp.rows) {
    if (r.touched) continue;
    const cls = B.classify(r.op, ctx);
    r.cls = cls;
    if (r.op.direction === 'credit') {
      const refund = S.imp.pendingR.find((t) => Math.abs(Number(t.amount) - r.op.amount) < 0.005 && t.date <= r.op.date);
      r.choice = cls.kind === 'ignore' ? 'ignore' : cls.kind === 'salaire' ? 'salaire' : refund ? `refund-e:${refund.id}` : 'revenu';
    } else {
      r.choice = cls.kind === 'ignore' ? 'ignore' : cls.reimbursable ? 'rembourse' : cls.category_id ? `cat:${cls.category_id}` : 'aclasser';
    }
    r.auto = r.choice;
  }
}

function importChoices(r) {
  if (r.op.direction === 'credit') {
    return [['salaire', '💶 Salaire (démarre le mois de budget)'], ['revenu', '➕ Rentrée d’argent (prime, aide…)'],
      ...S.imp.pendingR.flatMap((t) => [[`refund-e:${t.id}`, `↩︎ Remb. « ${t.label || t.merchant || 'avance'} » → épargne`], [`refund-b:${t.id}`, `↩︎ Remb. « ${t.label || t.merchant || 'avance'} » → budget`]]),
      ['ignore', '⏭ Ignorer (virement entre mes comptes)']];
  }
  return [['aclasser', '❓ À classer plus tard'], ...activeCats().map((c) => [`cat:${c.id}`, `${c.icon} ${c.name}`]),
    ['rembourse', '↩︎ Remboursement attendu'], ['ignore', '⏭ Ignorer (ne compte pas)']];
}

function viewImport() {
  const I = S.imp;
  const rows = I.rows;
  const fresh = rows.filter((r) => r.status === 'new');
  const add = fresh.filter((r) => r.choice !== 'ignore');
  const ignored = fresh.filter((r) => r.choice === 'ignore');
  const already = rows.filter((r) => r.status !== 'new');
  const needName = !ownerNames().length && rows.some((r) => /\bVIR/i.test(r.op.label));
  const periodTxt = I.period ? C.rangeLabel({ start: I.period.from, end: I.period.to }) : '';
  const line = (r) => `<div class="imp-row ${r.op.direction}">
      <span class="imp-main"><span class="tx-date">${esc(C.dayLabel(r.op.date))}</span>
        <span class="imp-label">${esc(r.op.label)}${r.op.detail ? ` <small class="muted">${esc(r.op.detail)}</small>` : ''}</span>
        <b>${r.op.direction === 'credit' ? '+' : '−'}${money(r.op.amount)}</b></span>
      ${r.status === 'new' ? `<select data-imp="${r.i}" aria-label="Classement">${importChoices(r).map(([v, l]) => `<option value="${esc(v)}" ${v === r.choice ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
        : `<small class="muted">${r.status === 'dup' ? 'déjà ajoutée depuis l’iPhone ou à la main' : 'déjà importée'}</small>`}
    </div>`;
  return `
  <header class="top"><button class="link" data-act="imp-cancel">Annuler</button><h1>Relevé ${esc(I.bank.name)}</h1><span></span></header>
  <p class="muted">${esc(periodTxt)} · ${rows.length} opérations${I.closing !== null ? ` · solde ${money(I.closing)}` : ''}</p>
  <div class="stats">
    <div class="stat main"><span>À ajouter</span><b>${add.length}</b></div>
    <div class="stat"><span>Ignorées</span><b>${ignored.length}</b></div>
    <div class="stat"><span>Déjà présentes</span><b>${already.length}</b></div>
  </div>
  ${needName ? `<form class="card form banner-form" data-form="imp-owner">
      <label>Ton nom tel qu’il apparaît sur le relevé, pour reconnaître tes virements entre tes comptes
        <input name="name" placeholder="ex. DUPONT ALEX" maxlength="120" required></label>
      <button class="btn small">Appliquer</button></form>` : ''}
  <p class="note">Vérifie le classement proposé et change-le si besoin : l’app retiendra tes choix pour les prochains relevés.</p>
  ${add.length ? `<section class="group"><h2>À ajouter <span class="muted">${add.length}</span></h2><div class="card list">${add.map(line).join('')}</div></section>` : ''}
  ${ignored.length ? `<details class="group"><summary><h2>Ignorées <span class="muted">${ignored.length} · virements entre tes comptes…</span></h2></summary>
      <div class="card list">${ignored.map(line).join('')}</div></details>` : ''}
  ${already.length ? `<details class="group"><summary><h2>Déjà dans l’app <span class="muted">${already.length}</span></h2></summary>
      <div class="card list">${already.map(line).join('')}</div></details>` : ''}
  ${I.closing !== null ? `<label class="opt check card pad-card"><input type="checkbox" data-imp-balance ${I.updateBalance ? 'checked' : ''}>
      <span>Mettre à jour le solde du compte ${esc(I.bank.name)} : <b>${money(I.closing)}</b></span></label>` : ''}
  <div class="imp-footer"><button class="btn primary block" data-act="imp-save">Importer ${add.length + ignored.length} opération${add.length + ignored.length > 1 ? 's' : ''}</button></div>
  <div class="fab-space"></div>`;
}

async function saveImport() {
  const I = S.imp;
  const bankName = I.bank.name;
  const txs = [];
  const updates = [];
  const monthRows = [];
  const rules = [];
  for (const r of I.rows) {
    if (r.status === 'dup' && r.dupId) {       // relie la dépense iPhone à la ligne du relevé
      updates.push([r.dupId, { external_id: r.ext, bank: bankName, bank_label: `${r.op.label} ${r.op.detail || ''}`.trim().slice(0, 300) }]);
      continue;
    }
    if (r.status !== 'new') continue;
    const base = {
      id: newId(), date: r.op.date, amount: r.op.amount, source: 'import', bank: bankName, external_id: r.ext,
      bank_label: `${r.op.label} ${r.op.detail || ''}`.trim().slice(0, 300),
      merchant: r.cls?.merchant ? r.cls.merchant.slice(0, 120) : null, label: null,
    };
    const [kind, ref] = r.choice.split(':');
    if (kind === 'cat') txs.push({ ...base, kind: 'depense', category_id: ref });
    else if (kind === 'aclasser') txs.push({ ...base, kind: 'depense', category_id: null });
    else if (kind === 'rembourse') txs.push({ ...base, kind: 'depense', reimbursable: true, label: base.merchant });
    else if (kind === 'ignore') txs.push({ ...base, kind: 'ignore' });
    else if (kind === 'revenu') txs.push({ ...base, kind: 'revenu', label: base.merchant });
    else if (kind === 'salaire') {
      const key = C.periodForSalary(r.op.date, payDay()) || C.periodOf(r.op.date, S.data.months, payDay());
      monthRows.push({ month: key, income: r.op.amount, start_date: r.op.date });
      txs.push({ ...base, kind: 'ignore', label: 'Salaire' });
    } else if (kind === 'refund-e' || kind === 'refund-b') {
      updates.push([ref, { reimbursed_at: r.op.date, reimbursed_to: kind === 'refund-e' ? 'epargne' : 'budget' }]);
      txs.push({ ...base, kind: 'ignore', label: 'Remboursement' });
    }
    // Choix modifié à la main : on le retient pour ce commerçant
    if (r.touched && r.op.direction === 'debit' && r.cls?.merchant && r.choice !== r.auto && !/^(VIR|VIREMENT)/i.test(r.op.label)) {
      if (kind === 'cat') rules.push([r.cls.merchant, 'categorie', ref]);
      else if (kind === 'ignore') rules.push([r.cls.merchant, 'ignorer', null]);
      else if (kind === 'rembourse') rules.push([r.cls.merchant, 'rembourse', null]);
    }
  }
  S.screen = 'loading'; render();
  try {
    for (let i = 0; i < txs.length; i += 400) await S.store.insert('transactions', txs.slice(i, i + 400));
    for (const [id, patch] of updates) await S.store.update('transactions', { id }, patch);
    if (monthRows.length) await S.store.upsert('months', monthRows);
    for (const [m, a, c] of rules) await learnRule(m, a, c);
    if (I.updateBalance && I.closing !== null) {
      const acc = S.data.accounts.find((a) => a.bank === bankName) || S.data.accounts.find((a) => a.name.toLowerCase() === bankName.toLowerCase());
      const patch = { balance: I.closing, updated_at: new Date().toISOString() };
      if (acc) await S.store.update('accounts', { id: acc.id }, patch);
      else await S.store.insert('accounts', [{ name: bankName, kind: 'courant', bank: bankName, ...patch, position: S.data.accounts.length }]);
    }
    const n = txs.filter((t) => t.kind !== 'ignore').length;
    S.imp = null;
    await loadData();
    toast(`Relevé importé : ${n} opération${n > 1 ? 's' : ''} ajoutée${n > 1 ? 's' : ''}`, 'ok');
  } catch (e) {
    toast(`Import interrompu : ${e.message}`, 'error');
    S.imp = null;
    await loadData();
  }
}

// ── Feuilles (fenêtres du bas) ──────────────────────────────────────────────
function renderSheet() {
  const root = $('#sheet-root');
  const sh = S.sheet;
  if (!sh) { root.innerHTML = ''; document.body.classList.remove('sheet-open'); return; }
  document.body.classList.add('sheet-open');
  const body = {
    tx: sheetTx, salary: sheetSalary, refund: sheetRefund, account: sheetAccount, recovery: sheetRecovery,
  }[sh.type]();
  root.innerHTML = `<div class="backdrop" data-act="sheet-close"></div>
    <div class="sheet" role="dialog" aria-modal="true">${body}</div>`;
}

function sheetTx() {
  const sh = S.sheet;
  const t = sh.tx;
  const isNew = !t;
  const rule = sh.merchant && S.data.merchant_rules.find((r) => r.merchant === B.ruleKey(sh.merchant));
  const suggested = rule?.action === 'categorie' ? rule.category_id : null;
  const selected = sh.catId ?? t?.category_id ?? null;
  const kind = sh.kind || t?.kind || 'depense';
  const spread = t?.spread_months || 1;
  const reimb = t ? !!t.reimbursable : false;
  return `
  <div class="sheet-head">
    <button class="link" data-act="sheet-close">Annuler</button>
    <strong>${isNew ? (kind === 'revenu' ? 'Nouvelle rentrée' : 'Nouvelle dépense') : 'Modifier'}</strong>
    <button class="link strong" data-act="tx-save">OK</button>
  </div>
  <div class="seg small-seg">
    <button data-act="tx-kind" data-kind="depense" aria-selected="${kind !== 'revenu'}">Dépense</button>
    <button data-act="tx-kind" data-kind="revenu" aria-selected="${kind === 'revenu'}">Rentrée d’argent</button>
  </div>
  <label class="amount"><input id="f-amount" inputmode="decimal" placeholder="0,00" value="${inputNum(sh.amount ?? t?.amount)}" aria-label="Montant" autocomplete="off"><span>€</span></label>
  <div class="two">
    <input id="f-label" placeholder="Note (facultatif)" value="${esc(t?.label || '')}" maxlength="120" aria-label="Note">
    <input id="f-date" type="date" value="${esc(t?.date || sh.date || C.dateKey())}" aria-label="Date">
  </div>
  ${sh.merchant || t?.bank_label ? `<p class="note">${t?.bank_label ? `Relevé : <b>${esc(t.bank_label)}</b>` : `Commerçant : <b>${esc(sh.merchant)}</b>`}</p>` : ''}
  ${kind === 'revenu' ? '' : `
  <div class="options">
    <label class="opt">Lisser sur
      <select id="f-spread">${[1, 2, 3, 4, 5, 6, 9, 12].map((n) => `<option value="${n}" ${n === spread ? 'selected' : ''}>${n === 1 ? 'ce mois seulement' : `${n} mois`}</option>`).join('')}</select></label>
    <label class="opt check"><input type="checkbox" id="f-reimb" ${reimb ? 'checked' : ''}> On doit me la rembourser</label>
  </div>
  <p class="hint">${isNew ? 'Touche une catégorie pour enregistrer' : 'Choisis la catégorie puis OK'}</p>
  <div class="cat-grid">
    ${activeCats().map((c) => `<button class="cat-pick ${c.id === selected ? 'selected' : ''} ${c.id === suggested ? 'suggested' : ''}" data-act="pick-cat" data-id="${esc(c.id)}">
      <span>${esc(c.icon)}</span><small>${esc(c.name)}</small></button>`).join('')}
  </div>`}
  ${t?.reimbursable && !t.reimbursed_at ? `<button class="btn block" data-act="refund" data-id="${esc(t.id)}">Marquer comme remboursée</button>` : ''}
  ${t?.reimbursed_at ? `<p class="note">Remboursée le ${esc(C.dayLabel(t.reimbursed_at))} → ${t.reimbursed_to === 'budget' ? 'budget du mois' : 'épargne'}.
      <button class="link small" data-act="refund-undo" data-id="${esc(t.id)}">Annuler</button></p>` : ''}
  ${t && t.kind === 'depense' && t.bank_label ? `<button class="btn ghost block" data-act="tx-ignore">Ne pas compter cette opération</button>` : ''}
  ${!isNew ? '<button class="btn danger block" data-act="tx-delete">Supprimer</button>' : ''}`;
}

function sheetSalary() {
  const key = S.sheet.key;
  const row = S.data.months.find((m) => m.month === key);
  const range = C.periodRange(key, S.data.months, payDay());
  const isNew = S.sheet.fromBanner;
  const date = isNew ? todayKey() : (row?.start_date || range.start);
  const inc = row && row.income !== null && row.income !== undefined ? row.income : usualIncome();
  return `<div class="sheet-head"><button class="link" data-act="sheet-close">Annuler</button>
    <strong>Salaire de ${esc(C.monthLabel(key))}</strong><span></span></div>
    <form class="form" data-form="salary">
      <label class="amount"><input name="income" inputmode="decimal" value="${inputNum(inc)}" aria-label="Montant du salaire"><span>€</span></label>
      <label>Reçu le<input name="date" type="date" value="${esc(date)}"></label>
      <p class="note">Ton mois de budget de ${esc(C.monthLabel(key))} démarre ce jour-là. Les primes, aides ou autres rentrées s’ajoutent avec le <b>+</b> (« Rentrée d’argent ») ou arrivent avec l’import de ton relevé.</p>
      <button class="btn primary block">Enregistrer</button>
    </form>`;
}

function sheetRefund() {
  const t = S.data.transactions.find((x) => x.id === S.sheet.id);
  return `<div class="sheet-head"><button class="link" data-act="sheet-close">Annuler</button>
    <strong>Remboursement reçu</strong><span></span></div>
    <p><b>${money(t.amount)}</b> · ${esc(t.label || t.merchant || 'Avance')} (${esc(C.dayLabel(t.date))})</p>
    <form class="form" data-form="refund">
      <label>Reçu le<input name="date" type="date" value="${esc(todayKey())}"></label>
      <p class="note">Où va cet argent ?</p>
      <button class="btn primary block" name="to" value="epargne">En épargne, pour mes projets</button>
      <button class="btn block" name="to" value="budget">Dans mon budget du mois</button>
    </form>`;
}

function sheetAccount() {
  const a = S.sheet.account || {};
  const isNew = !a.id;
  return `<div class="sheet-head"><button class="link" data-act="sheet-close">Annuler</button>
    <strong>${isNew ? 'Nouveau compte' : esc(a.name)}</strong><span></span></div>
    ${isNew ? `<div class="chips">${PRESETS.map((pr, i) => `<button class="chip" data-act="acc-preset" data-i="${i}">${esc(pr.name)}</button>`).join('')}</div>` : ''}
    <form class="form" data-form="account">
      <label>Nom<input name="name" value="${esc(a.name || '')}" maxlength="40" required></label>
      <label>Type<select name="kind">${Object.entries(KINDS).map(([k, [, l]]) => `<option value="${k}" ${a.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="two">
        <label>Solde<span class="suffix"><input name="balance" inputmode="decimal" value="${inputNum(a.balance)}" placeholder="0"><i>€</i></span></label>
        <label>Taux<span class="suffix"><input name="rate" inputmode="decimal" value="${inputNum(a.rate)}" placeholder="0"><i>%</i></span></label>
      </div>
      <p class="note">Livret A et LDDS : 1,7 % · LEP : 2,5 % (taux en vigueur depuis le 1er août 2026). Le taux d’un PEL dépend de sa date d’ouverture.</p>
      <button class="btn primary block">Enregistrer</button>
      ${!isNew ? `<button type="button" class="btn danger block" data-act="acc-del" data-id="${esc(a.id)}">Supprimer ce compte</button>` : ''}
    </form>`;
}

function sheetRecovery() {
  return `<div class="sheet-head"><span></span><strong>Nouveau mot de passe</strong><span></span></div>
    <form class="form" data-form="recovery">
      <label>Nouveau mot de passe<input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
      <button class="btn primary block">Enregistrer</button>
    </form>`;
}

function openAdd({ amount = null, merchant = null, source = 'manuel', catId = null } = {}) {
  S.sheet = { type: 'tx', amount, merchant, source, catId, date: defaultDate() };
  renderSheet();
  const f = $('#f-amount');
  if (f && amount === null) f.focus();
}
// Ajout depuis un autre mois que celui en cours : daté du premier jour de ce mois de budget
const defaultDate = () => (S.month === currentKey() ? todayKey() : C.periodRange(S.month, S.data.months, payDay()).start);

// ── Écriture ─────────────────────────────────────────────────────────────────
async function guarded(fn) {
  try { return await fn(); } catch (e) {
    toast(e instanceof StoreError ? e.message : `Erreur : ${e.message}`, 'error');
    if (!e.network && S.screen === 'app') await loadData({ quiet: true });
    return undefined;
  }
}

/** Retient « ce commerçant → cette catégorie » (ou ignorer / à rembourser). */
async function learnRule(merchant, action, categoryId = null) {
  const key = merchant && B.ruleKey(merchant);
  if (!key) return;
  const rule = S.data.merchant_rules.find((r) => r.merchant === key);
  if (rule && rule.action === action && (rule.category_id || null) === (categoryId || null)) return;
  const row = { merchant: key, action, category_id: categoryId };
  await S.store.upsert('merchant_rules', [row]);
  if (rule) Object.assign(rule, row); else S.data.merchant_rules.push(row);
}

async function saveTx(categoryId) {
  const sh = S.sheet;
  const amount = C.parseAmount($('#f-amount').value);
  if (!amount) {
    $('#f-amount').closest('.amount').classList.add('shake');
    setTimeout(() => $('.amount')?.classList.remove('shake'), 400);
    toast('Indique un montant');
    $('#f-amount').focus();
    return;
  }
  const kind = sh.kind || sh.tx?.kind || 'depense';
  const catId = kind === 'revenu' ? null : (categoryId !== undefined ? categoryId : (sh.catId ?? sh.tx?.category_id ?? null));
  const reimbursable = kind === 'depense' && !!$('#f-reimb')?.checked;
  const row = {
    amount,
    kind,
    category_id: catId,
    label: $('#f-label').value.trim() || null,
    date: $('#f-date').value || todayKey(),
    spread_months: kind === 'depense' ? Number($('#f-spread')?.value || 1) : 1,
    reimbursable,
  };
  if (!reimbursable) { row.reimbursed_at = null; row.reimbursed_to = null; }
  S.sheet = null;
  const cat = catId && catById(catId);

  if (sh.tx?.pending) {                            // dépense pas encore envoyée
    storage.set(outboxKey(), outbox().map((t) => (t.id === sh.tx.id ? { ...t, ...row } : t)));
  } else if (sh.tx) {
    await guarded(async () => {
      const [upd] = await S.store.update('transactions', { id: sh.tx.id }, row);
      Object.assign(S.data.transactions.find((t) => t.id === sh.tx.id), upd || row);
    });
  } else {
    const full = { id: newId(), ...row, merchant: sh.merchant || null, source: sh.source === 'raccourci' ? 'raccourci' : 'manuel' };
    try {
      const [saved] = await S.store.insert('transactions', [full]);
      S.data.transactions.push(saved);
    } catch (e) {
      if (e.network) {
        storage.set(outboxKey(), [...outbox(), full]);
        toast('Hors connexion : la dépense partira dès le retour du réseau');
      } else { toast(e.message, 'error'); }
    }
  }
  const merchant = sh.merchant || sh.tx?.merchant || (sh.tx?.bank_label && B.merchantOf(sh.tx.bank_label));
  if (merchant && kind === 'depense' && (catId || reimbursable)) {
    guarded(() => learnRule(merchant, reimbursable ? 'rembourse' : 'categorie', catId));
  }
  S.month = C.periodOf(row.date, S.data.months, payDay());
  if (catId) S.expanded.add(catId);
  render();
  const what = kind === 'revenu' ? 'Rentrée d’argent' : reimbursable ? 'à rembourser' : cat ? `${cat.icon} ${cat.name}` : 'À classer';
  toast(`${C.euros(amount)} → ${what}${row.spread_months > 1 ? ` (lissé sur ${row.spread_months} mois)` : ''}`, 'ok');
}

async function deleteTx() {
  const t = S.sheet.tx;
  if (!confirm('Supprimer cette opération ?')) return;
  S.sheet = null;
  if (t.pending) {
    storage.set(outboxKey(), outbox().filter((x) => x.id !== t.id));
  } else {
    await guarded(async () => {
      await S.store.remove('transactions', { id: t.id });
      S.data.transactions = S.data.transactions.filter((x) => x.id !== t.id);
    });
  }
  render();
  toast('Opération supprimée');
}

async function patchRow(table, match, patch, local) {
  Object.assign(local, patch);
  render();
  await guarded(() => S.store.update(table, match, patch));
}
const patchSettings = (patch) => patchRow('settings', { user_id: S.data.settings.user_id }, patch, S.data.settings);

function coerce(el) {
  const v = el.value;
  switch (el.dataset.type) {
    case 'money': return C.parseAmount(v) ?? 0;
    case 'money-null': return v.trim() === '' ? null : C.parseAmount(v);
    case 'int': return Math.min(28, Math.max(1, parseInt(v, 10) || 1));
    case 'day31': return Math.min(31, Math.max(1, parseInt(v, 10) || 1));
    default: return el.tagName === 'SELECT' ? (v || null) : v.trim();
  }
}

// ── Import / export ─────────────────────────────────────────────────────────
function exportBackup() {
  const d = S.data;
  const strip = ({ user_id, ...rest }) => rest;
  const { shortcut_token, snapshot, ...settings } = strip(d.settings);
  const obj = {
    app: 'mon-budget',
    version: 2,
    exported_at: new Date().toISOString(),
    data: {
      settings,
      ...Object.fromEntries(C.BACKUP_TABLES.map((t) => [t, d[t].map(strip)])),
    },
  };
  const name = `mon-budget-${C.dateKey()}.json`;
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    navigator.share({ files: [file], title: 'Sauvegarde Mon Budget' }).catch(() => {});
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function importBackup(file) {
  let obj;
  try { obj = JSON.parse(await file.text()); } catch { return toast('Fichier illisible.', 'error'); }
  const err = C.validateBackup(obj);
  if (err) return toast(err, 'error');
  const d = obj.data;
  const n = (d.transactions || []).length;
  if (S.data?.settings && !confirm(`Importer ${n} dépense${n > 1 ? 's' : ''} ? Toutes les données actuelles de ce compte seront remplacées.`)) return;

  S.screen = 'loading'; S.sheet = null; render();
  try {
    for (const t of ['transactions', 'fixed_charges', 'merchant_rules', 'categories', 'months', 'projects', 'accounts']) {
      await S.store.removeAll(t);
    }
    const catMap = new Map();
    const cats = d.categories.map((c, i) => {
      const id = newId();
      catMap.set(c.id ?? c.ref ?? `#${i}`, id);
      return { id, name: c.name, icon: c.icon || '📦', kind: c.kind || 'variable', budget: Number(c.budget || 0), position: c.position ?? i, archived: !!c.archived };
    });
    await chunked('categories', cats);
    const mapCat = (id) => (id == null ? null : catMap.get(id) ?? null);

    const fixMap = new Map();
    const fixed = (d.fixed_charges || []).filter((f) => mapCat(f.category_id)).map((f) => {
      const id = newId();
      fixMap.set(f.id, id);
      return { id, category_id: mapCat(f.category_id), label: f.label, amount: Number(f.amount), day: f.day || 1, active: f.active !== false };
    });
    await chunked('fixed_charges', fixed);

    const txs = (d.transactions || []).map((t) => {
      let fk = null;
      if (t.fixed_key) {
        const [fid, m] = t.fixed_key.split(':');
        fk = fixMap.has(fid) ? `${fixMap.get(fid)}:${m}` : null;
      }
      return {
        id: newId(), date: t.date, amount: C.parseAmount(t.amount), category_id: mapCat(t.category_id),
        label: t.label || null, merchant: t.merchant || null,
        source: ['manuel', 'raccourci', 'fixe', 'import'].includes(t.source) ? t.source : 'import', fixed_key: fk,
        kind: ['depense', 'revenu', 'ignore'].includes(t.kind) ? t.kind : 'depense',
        reimbursable: !!t.reimbursable, reimbursed_at: t.reimbursed_at || null,
        reimbursed_to: ['epargne', 'budget'].includes(t.reimbursed_to) ? t.reimbursed_to : null,
        spread_months: Math.min(36, Math.max(1, Number(t.spread_months || 1))),
        bank: t.bank || null, bank_label: t.bank_label || null, external_id: t.external_id || null,
      };
    });
    await chunked('transactions', txs);
    if (d.months?.length) {
      await S.store.upsert('months', d.months.map((m) => ({
        month: m.month, income: m.income === null || m.income === undefined ? null : Number(m.income), start_date: m.start_date || null,
      })));
    }
    await chunked('projects', (d.projects || []).map((p, i) => ({ name: p.name, price: p.price ?? null, bought: !!p.bought, position: p.position ?? i })));
    await chunked('accounts', (d.accounts || []).map((a, i) => ({
      name: a.name, kind: a.kind || 'autre', balance: Number(a.balance || 0), rate: Number(a.rate || 0), position: a.position ?? i, bank: a.bank || null,
      updated_at: a.updated_at || new Date().toISOString(),
    })));
    const rules = (d.merchant_rules || [])
      .filter((r) => (r.action && r.action !== 'categorie') || mapCat(r.category_id))
      .map((r) => ({ merchant: r.merchant, action: r.action || 'categorie', category_id: mapCat(r.category_id) }));
    if (rules.length) await S.store.upsert('merchant_rules', rules);
    const st = d.settings || {};
    await S.store.upsert('settings', [{
      default_income: Number(st.default_income || 0), projects_total: Number(st.projects_total || 0),
      goal_start: st.goal_start || null, goal_end: st.goal_end || null, timezone: st.timezone || 'Europe/Paris',
      pay_day: Math.min(31, Math.max(1, Number(st.pay_day || 1))), owner_names: st.owner_names || null,
    }]);
    S.wiz = null;
    S.month = null;
    await loadData();
    toast(`Import terminé : ${txs.length} opérations`, 'ok');
  } catch (e) {
    toast(`Import interrompu : ${e.message}`, 'error');
    await loadData();
  }
}

async function chunked(table, rows) {
  for (let i = 0; i < rows.length; i += 400) await S.store.insert(table, rows.slice(i, i + 400));
}

// ── Événements ───────────────────────────────────────────────────────────────
const actions = {
  tab: (el) => { S.view = el.dataset.view; S.sheet = null; render(); scrollTo(0, 0); },
  retry: () => (S.user ? loadData() : boot()),
  'month-prev': () => { S.month = C.addMonths(S.month, -1); render(); },
  'month-next': () => { S.month = C.addMonths(S.month, 1); render(); },
  'month-today': () => { S.month = currentKey(); render(); },
  'toggle-cat': (el) => { const id = el.dataset.id; S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id); render(); },
  add: () => openAdd(),
  'add-in-cat': (el) => { S.sheet = { type: 'tx', catId: el.dataset.id, date: defaultDate() }; renderSheet(); $('#f-amount')?.focus(); },
  'edit-tx': (el) => {
    const t = allTx().find((x) => x.id === el.dataset.id);
    if (t) { S.sheet = { type: 'tx', tx: t, merchant: t.merchant, catId: null }; renderSheet(); }
  },
  'edit-income': () => { S.sheet = { type: 'salary', key: S.month }; renderSheet(); },
  salary: () => { S.sheet = { type: 'salary', key: C.salaryTarget(todayKey(), S.data.months, payDay()), fromBanner: true }; renderSheet(); },
  'tx-kind': (el) => {
    const amount = $('#f-amount')?.value;
    S.sheet.kind = el.dataset.kind;
    renderSheet();
    if (amount) $('#f-amount').value = amount;
  },
  refund: (el) => { S.sheet = { type: 'refund', id: el.dataset.id }; renderSheet(); },
  'refund-undo': async (el) => {
    const t = S.data.transactions.find((x) => x.id === el.dataset.id);
    S.sheet = null;
    await patchRow('transactions', { id: t.id }, { reimbursed_at: null, reimbursed_to: null }, t);
  },
  'tx-ignore': async () => {
    const t = S.sheet.tx;
    S.sheet = null;
    await patchRow('transactions', { id: t.id }, { kind: 'ignore' }, t);
    toast('Opération ignorée');
  },
  'statement-pick': () => $('#statement-file')?.click(),
  'imp-cancel': () => { S.imp = null; render(); },
  'imp-save': () => saveImport(),
  'rule-del': async (el) => {
    const key = el.dataset.key;
    await guarded(async () => {
      await S.store.remove('merchant_rules', { merchant: key });
      S.data.merchant_rules = S.data.merchant_rules.filter((r) => r.merchant !== key);
    });
    render();
  },
  'wiz-next': async (el) => {
    const w = S.wiz;
    if (w.step === 1 && !el.dataset.skip && !C.parseAmount(w.income)) { toast('Indique ton salaire (tu pourras le changer)'); return; }
    if (w.step >= WIZ_STEPS.length - 1) { await guarded(finishWizard); return; }
    w.step++;
    render();
    scrollTo(0, 0);
  },
  'wiz-back': () => { S.wiz.step = Math.max(0, S.wiz.step - 1); render(); },
  'wiz-add-fixed': () => { S.wiz.fixed.push({ label: '', amount: '', day: '1', cat: 'Abonnements' }); render(); },
  'wiz-del-fixed': (el) => { S.wiz.fixed.splice(+el.dataset.i, 1); render(); },
  'sheet-close': () => { if (S.sheet?.type === 'recovery') return; S.sheet = null; renderSheet(); },
  'pick-cat': (el) => {
    if (!S.sheet.tx) return saveTx(el.dataset.id);
    S.sheet.catId = el.dataset.id;
    document.querySelectorAll('.cat-pick').forEach((b) => b.classList.toggle('selected', b === el));
    return undefined;
  },
  'tx-save': () => saveTx(),
  'tx-delete': () => deleteTx(),

  'proj-toggle': (el) => { const p = S.data.projects.find((x) => x.id === el.dataset.id); patchRow('projects', { id: p.id }, { bought: !p.bought }, p); },
  'proj-del': async (el) => {
    const p = S.data.projects.find((x) => x.id === el.dataset.id);
    if (!confirm(`Supprimer « ${p.name} » ?`)) return;
    await guarded(async () => { await S.store.remove('projects', { id: p.id }); S.data.projects = S.data.projects.filter((x) => x !== p); });
    render();
  },

  'acc-add': () => { S.sheet = { type: 'account', account: { kind: 'livret' } }; renderSheet(); },
  'acc-edit': (el) => { S.sheet = { type: 'account', account: { ...S.data.accounts.find((a) => a.id === el.dataset.id) } }; renderSheet(); },
  'acc-preset': (el) => {
    const p = PRESETS[+el.dataset.i];
    const form = $('[data-form="account"]');
    form.name.value = p.name; form.kind.value = p.kind;
    if (p.rate !== null) form.rate.value = inputNum(p.rate);
    form.balance.focus();
  },
  'acc-del': async (el) => {
    if (!confirm('Supprimer ce compte ?')) return;
    S.sheet = null;
    await guarded(async () => { await S.store.remove('accounts', { id: el.dataset.id }); S.data.accounts = S.data.accounts.filter((a) => a.id !== el.dataset.id); });
    render();
  },

  'sim-tab': (el) => { S.sim.tab = el.dataset.tab; storage.set('mb.sim', S.sim); render(); },
  'sim-reset': () => { delete S.sim[S.sim.tab]; storage.set('mb.sim', S.sim); render(); },
  'sim-from-acc': (el) => {
    const a = S.data.accounts.find((x) => x.id === el.dataset.id);
    S.sim.epargne = { ...(S.sim.epargne || {}), initial: Number(a.balance), rate: Number(a.rate) };
    storage.set('mb.sim', S.sim); render();
  },

  'cat-move': async (el) => {
    const cats = [...S.data.categories].sort((a, b) => a.position - b.position);
    const i = cats.findIndex((c) => c.id === el.dataset.id);
    if (i <= 0) return;
    [cats[i - 1], cats[i]] = [cats[i], cats[i - 1]];
    cats.forEach((c, k) => { c.position = k; });
    render();
    await guarded(() => Promise.all([cats[i - 1], cats[i]].map((c) => S.store.update('categories', { id: c.id }, { position: c.position }))));
  },
  'cat-archive': (el) => { const c = catById(el.dataset.id); patchRow('categories', { id: c.id }, { archived: !c.archived }, c); },
  'fix-del': async (el) => {
    if (!confirm('Supprimer cette charge fixe ? (les dépenses déjà créées restent)')) return;
    await guarded(async () => { await S.store.remove('fixed_charges', { id: el.dataset.id }); S.data.fixed_charges = S.data.fixed_charges.filter((f) => f.id !== el.dataset.id); });
    render();
  },
  copy: async (el) => {
    try { await navigator.clipboard.writeText(el.dataset.value); toast('Copié', 'ok'); } catch { prompt('Copie ce texte :', el.dataset.value); }
  },
  'token-reset': () => { if (confirm('Créer un nouveau jeton ? Il faudra le recoller dans le raccourci iPhone.')) patchSettings({ shortcut_token: newToken() }); },
  export: () => exportBackup(),
  'import-pick': () => $('#import-file')?.click(),
  logout: async () => {
    if (S.store.mode === 'local') { if (!confirm('Quitter le mode local ? Tes données restent sur cet appareil.')) return; setLocalMode(false); location.reload(); return; }
    stopSync(); await S.store.signOut(); entering = null; S.user = null; S.data = null; S.screen = 'auth'; render();
  },
  'delete-account': async () => {
    const answer = prompt('Toutes tes données seront effacées définitivement. Tape SUPPRIMER pour confirmer.');
    if (answer?.trim().toUpperCase() !== 'SUPPRIMER') return;
    await guarded(async () => {
      await S.store.rpc('delete_my_account');
      storage.del(outboxKey());
      if (S.store.mode === 'local') { setLocalMode(false); location.reload(); return; }
      await S.store.signOut(); location.reload();
    });
  },
  'auth-mode': (el) => { S.authMode = el.dataset.mode; S.authMsg = null; render(); },
  'local-mode': () => { setLocalMode(true); location.reload(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.sheet) actions['sheet-close']();
  if (e.key === 'Enter' && e.target.id === 'f-amount' && (S.sheet?.tx || S.sheet?.catId)) saveTx();
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'import-file' && el.files[0]) return importBackup(el.files[0]);
  if (el.id === 'statement-file' && el.files[0]) { const f = el.files[0]; el.value = ''; return startImport(f); }
  if (el.dataset.imp !== undefined) {
    const r = S.imp.rows[+el.dataset.imp];
    r.choice = el.value;
    r.touched = true;
    render();
    return undefined;
  }
  if (el.dataset.impBalance !== undefined) { S.imp.updateBalance = el.checked; return undefined; }
  if (el.dataset.wiz && el.tagName === 'SELECT') { setWiz(el.dataset.wiz, el.value); return undefined; }
  const id = el.dataset.id;
  if (el.dataset.set) return patchSettings({ [el.dataset.set]: coerce(el) });
  if (el.dataset.cat) {
    const c = catById(id); const v = coerce(el);
    if (el.dataset.cat === 'name' && !v) { el.value = c.name; return undefined; }
    return patchRow('categories', { id }, { [el.dataset.cat]: v || (el.dataset.cat === 'icon' ? '📦' : v) }, c);
  }
  if (el.dataset.fix) {
    const f = S.data.fixed_charges.find((x) => x.id === id); const v = coerce(el);
    if (el.dataset.fix === 'label' && !v) { el.value = f.label; return undefined; }
    return patchRow('fixed_charges', { id }, { [el.dataset.fix]: v }, f);
  }
  if (el.dataset.proj) {
    const p = S.data.projects.find((x) => x.id === id); const v = coerce(el);
    if (el.dataset.proj === 'name' && !v) { el.value = p.name; return undefined; }
    return patchRow('projects', { id }, { [el.dataset.proj]: v }, p);
  }
  return undefined;
});

function setWiz(path, value) {
  const parts = path.split('.');
  let o = S.wiz;
  while (parts.length > 1) o = o[parts.shift()];
  o[parts[0]] = value;
}

document.addEventListener('input', (e) => {
  if (e.target.dataset.wiz) { setWiz(e.target.dataset.wiz, e.target.value); return; }
  const k = e.target.dataset.sim;
  if (!k) return;
  S.sim[S.sim.tab] = { ...(S.sim[S.sim.tab] || {}), [k]: e.target.value };
  storage.set('mb.sim', S.sim);
  renderSim();
});

const forms = {
  async login(f) {
    S.busy = true; S.authMsg = null; render();
    try { await S.store.signIn(f.email.value.trim(), f.password.value); S.busy = false; await enterApp(await S.store.getUser()); }
    catch (e) { S.busy = false; S.authMsg = { text: e.message }; render(); }
  },
  async signup(f) {
    S.busy = true; S.authMsg = null; render();
    try {
      const r = await S.store.signUp(f.email.value.trim(), f.password.value);
      S.busy = false;
      if (r.needsConfirmation) { S.authMode = 'login'; S.authMsg = { ok: true, text: 'Compte créé ! Ouvre le lien reçu par email pour le confirmer, puis connecte-toi ici.' }; render(); }
      else await enterApp(await S.store.getUser());
    } catch (e) { S.busy = false; S.authMsg = { text: e.message }; render(); }
  },
  async forgot(f) {
    S.busy = true; render();
    try { await S.store.resetPassword(f.email.value.trim()); S.authMsg = { ok: true, text: 'Si un compte existe, un lien vient d’être envoyé par email.' }; }
    catch (e) { S.authMsg = { text: e.message }; }
    S.busy = false; render();
  },
  async recovery(f) {
    try { await S.store.updatePassword(f.password.value); S.sheet = null; toast('Mot de passe modifié', 'ok'); render(); }
    catch (e) { toast(e.message, 'error'); }
  },
  config(f) {
    const url = f.url.value.trim();
    if (!/^https:\/\/.+/.test(url)) return toast('L’adresse doit commencer par https://', 'error');
    saveDeviceConfig(url, f.key.value);
    location.reload();
    return undefined;
  },
  async salary(f) {
    const key = S.sheet.key;
    const income = C.parseAmount(f.income.value);
    if (income === null) return toast('Indique un montant', 'error');
    const date = f.date.value || todayKey();
    const target = S.sheet.fromBanner ? (C.periodForSalary(date, payDay()) || key) : key;
    S.sheet = null;
    await guarded(async () => {
      const row = { month: target, income, start_date: date };
      await S.store.upsert('months', [row]);
      const m = S.data.months.find((x) => x.month === target);
      if (m) Object.assign(m, row); else S.data.months.push(row);
      await ensureFixed();
    });
    S.month = currentKey();
    render();
    toast(`Salaire enregistré : ton budget de ${C.monthLabel(target)} démarre le ${C.dayLabel(date)}`, 'ok');
    return undefined;
  },
  async refund(f, submitter) {
    const t = S.data.transactions.find((x) => x.id === S.sheet.id);
    const to = submitter?.value === 'budget' ? 'budget' : 'epargne';
    S.sheet = null;
    await patchRow('transactions', { id: t.id }, { reimbursed_at: f.date.value || todayKey(), reimbursed_to: to }, t);
    toast(to === 'budget' ? 'Remboursement ajouté à ton budget du mois' : 'Remboursement ajouté à ton épargne', 'ok');
  },
  async 'imp-owner'(f) {
    const name = f.name.value.trim();
    if (!name) return;
    await patchSettings({ owner_names: name });
    classifyImport();
    render();
  },
  async account(f) {
    const a = S.sheet.account;
    const row = {
      name: f.name.value.trim(), kind: f.kind.value,
      balance: C.parseAmount(f.balance.value) ?? 0, rate: C.parseAmount(f.rate.value) ?? 0,
      updated_at: new Date().toISOString(),
    };
    if (f.balance.value.trim().startsWith('-')) row.balance = -row.balance;
    S.sheet = null;
    await guarded(async () => {
      if (a.id) { await S.store.update('accounts', { id: a.id }, row); Object.assign(S.data.accounts.find((x) => x.id === a.id), row); }
      else { const [saved] = await S.store.insert('accounts', [{ ...row, position: S.data.accounts.length }]); S.data.accounts.push(saved); }
    });
    render();
  },
  async 'proj-add'(f) {
    const row = { name: f.name.value.trim(), price: f.price.value.trim() ? C.parseAmount(f.price.value) : null, position: S.data.projects.length };
    if (!row.name) return;
    await guarded(async () => { const [saved] = await S.store.insert('projects', [row]); S.data.projects.push(saved); });
    render();
    $('[data-form="proj-add"] [name="name"]')?.focus();
  },
  async 'cat-add'(f) {
    const row = { name: f.name.value.trim(), icon: f.icon.value.trim() || '📦', kind: 'variable', position: S.data.categories.length };
    await guarded(async () => { const [saved] = await S.store.insert('categories', [row]); S.data.categories.push(saved); });
    render();
  },
  async 'fix-add'(f) {
    const amount = C.parseAmount(f.amount.value);
    if (amount === null) return toast('Montant invalide', 'error');
    if (!f.category_id.value) return toast('Choisis une catégorie', 'error');
    const row = { label: f.label.value.trim(), amount, day: Math.min(28, Math.max(1, parseInt(f.day.value, 10) || 1)), category_id: f.category_id.value };
    await guarded(async () => {
      const [saved] = await S.store.insert('fixed_charges', [row]);
      S.data.fixed_charges.push(saved);
      await ensureFixed();
    });
    render();
    return undefined;
  },
};

document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  forms[f.dataset.form]?.(f, e.submitter);
});

// ── Petites choses ──────────────────────────────────────────────────────────
let toastTimer;
function toast(text, kind = '') {
  const el = $('#toast');
  el.textContent = text;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2600);
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// Utilisé par les tests automatiques
window.__monBudget = { S, C };

boot();
