// ─────────────────────────────────────────────────────────────────────────────
// Accès aux données. Deux modes avec la même interface :
//   • cloud  : Supabase (comptes, synchro entre appareils, raccourci iPhone)
//   • local  : navigateur uniquement (essai sans compte, tests automatiques)
// ─────────────────────────────────────────────────────────────────────────────
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const TABLES = ['categories', 'transactions', 'fixed_charges', 'months', 'projects', 'accounts', 'settings', 'merchant_rules'];

// Clé d'unicité de chaque table (hors id)
const CONFLICT = {
  months: 'user_id,month',
  settings: 'user_id',
  merchant_rules: 'user_id,merchant',
  transactions: 'user_id,fixed_key',
};
const ORDER = { months: 'month', settings: 'user_id', merchant_rules: 'merchant' };

export class StoreError extends Error {
  constructor(message, { network = false, code = null } = {}) {
    super(message);
    this.network = network;
    this.code = code;
  }
}

const storage = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
};
export { storage };

export function getConfig() {
  if (SUPABASE_URL.trim() && SUPABASE_KEY.trim()) return { url: SUPABASE_URL.trim().replace(/\/+$/, ''), key: SUPABASE_KEY.trim(), source: 'app' };
  const c = storage.get('mb.config');
  if (c?.url && c?.key) return { url: c.url, key: c.key, source: 'appareil' };
  return null;
}
export const saveDeviceConfig = (url, key) => storage.set('mb.config', { url: url.trim().replace(/\/+$/, ''), key: key.trim() });
export const setLocalMode = (on) => (on ? storage.set('mb.mode', 'local') : storage.del('mb.mode'));
export const isLocalMode = () => storage.get('mb.mode') === 'local';

export function createStore() {
  if (isLocalMode()) return localStore();
  const cfg = getConfig();
  return cfg ? cloudStore(cfg) : null;
}

export const newId = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  }));

export const newToken = () => [...crypto.getRandomValues(new Uint8Array(32))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

// ── Messages d'erreur en français ───────────────────────────────────────────
function frenchAuth(msg = '') {
  const m = msg.toLowerCase();
  if (m.includes('invalid login')) return 'Email ou mot de passe incorrect.';
  if (m.includes('email not confirmed')) return 'Confirme d’abord ton adresse avec le lien reçu par email.';
  if (m.includes('already registered') || m.includes('already been registered')) return 'Un compte existe déjà avec cet email.';
  if (m.includes('password should be') || m.includes('at least')) return 'Mot de passe trop court (8 caractères minimum conseillés).';
  if (m.includes('rate limit') || m.includes('too many')) return 'Trop de tentatives. Réessaie dans quelques minutes.';
  if (m.includes('invalid email') || m.includes('unable to validate email')) return 'Adresse email invalide.';
  if (m.includes('signups not allowed') || m.includes('signup is disabled')) return 'Les inscriptions sont fermées sur ce serveur.';
  if (m.includes('not authorized') || m.includes('sending') || m.includes('smtp')) return 'Le serveur n’a pas pu envoyer l’email de confirmation. Dans Supabase : Authentication → Sign In / Providers → Email → décoche « Confirm email », puis réessaie.';
  if (m.includes('invalid api key') || m.includes('no api key')) return 'Clé Supabase refusée : la clé et l’adresse doivent venir du même projet Supabase (Project Settings → API Keys).';
  if (m.includes('fetch') || m.includes('load failed') || m.includes('network')) return navigator.onLine ? 'Impossible de joindre le serveur Supabase (projet en pause ou adresse incorrecte ?).' : 'Pas de connexion internet.';
  return msg || 'Erreur inconnue.';
}

const isNetwork = (e) => !navigator.onLine || /fetch|load failed|network|timeout/i.test(e?.message || '');

function wrap(error) {
  if (error instanceof StoreError) return error;
  const network = isNetwork(error);
  const msg = network ? 'Pas de connexion internet.' : (error?.message || 'Erreur inconnue.');
  return new StoreError(msg, { network, code: error?.code || null });
}

// ── Mode cloud (Supabase) ────────────────────────────────────────────────────
function cloudStore({ url, key }) {
  if (!window.supabase?.createClient) throw new StoreError('Bibliothèque Supabase introuvable.');
  const sb = window.supabase.createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'mb.auth' },
  });
  let user = null;
  const redirect = () => location.origin + location.pathname;
  const run = async (q) => {
    let res;
    try { res = await q; } catch (e) { throw wrap(e); }
    if (res.error) throw wrap(res.error);
    return res.data;
  };
  const withUser = (rows) => rows.map((r) => ({ ...r, user_id: user.id }));

  async function fetchAll(table) {
    const out = [];
    const size = 1000;
    for (let from = 0; ; from += size) {
      const data = await run(sb.from(table).select('*').order(ORDER[table] || 'id').range(from, from + size - 1));
      out.push(...data);
      if (data.length < size) return out;
    }
  }

  return {
    mode: 'cloud',
    url,
    key,
    async getUser() {
      const { data } = await sb.auth.getSession();
      user = data.session?.user ?? null;
      return user && { id: user.id, email: user.email };
    },
    onAuth(cb) {
      sb.auth.onAuthStateChange((event, session) => {
        user = session?.user ?? null;
        // Ne jamais appeler Supabase directement dans ce callback (verrou interne).
        setTimeout(() => cb(event, user && { id: user.id, email: user.email }), 0);
      });
    },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new StoreError(frenchAuth(error.message));
    },
    async signUp(email, password) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirect() } });
      if (error) throw new StoreError(frenchAuth(error.message));
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        throw new StoreError('Un compte existe déjà avec cet email.');
      }
      return { needsConfirmation: !data.session };
    },
    async resetPassword(email) {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirect() });
      if (error) throw new StoreError(frenchAuth(error.message));
    },
    async updatePassword(password) {
      const { error } = await sb.auth.updateUser({ password });
      if (error) throw new StoreError(frenchAuth(error.message));
    },
    async signOut() { await sb.auth.signOut(); user = null; },

    async loadAll() {
      const lists = await Promise.all(TABLES.map(fetchAll));
      const data = Object.fromEntries(TABLES.map((t, i) => [t, lists[i]]));
      data.settings = data.settings[0] || null;
      return data;
    },
    insert: (table, rows) => run(sb.from(table).insert(withUser(rows)).select()),
    upsert: (table, rows, { ignoreDuplicates = false } = {}) =>
      run(sb.from(table).upsert(withUser(rows), { onConflict: CONFLICT[table] || 'id', ignoreDuplicates }).select()),
    async update(table, match, patch) {
      let q = sb.from(table).update(patch);
      for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
      return run(q.select());
    },
    async remove(table, match) {
      let q = sb.from(table).delete();
      for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
      return run(q);
    },
    removeAll: (table) => run(sb.from(table).delete().eq('user_id', user.id)),
    rpc: (name, args) => run(sb.rpc(name, args)),

    // Synchronisation en direct : prévient dès qu'une donnée change (depuis un autre
    // appareil, le raccourci iPhone…). Les règles RLS filtrent : on ne reçoit que les siennes.
    subscribe(onChange, onStatus) {
      const channel = sb.channel(`mon-budget-${user.id}`)
        .on('postgres_changes', { event: '*', schema: 'public' }, () => onChange())
        .subscribe((status) => onStatus?.(status));
      return () => { sb.removeChannel(channel); };
    },
  };
}

// ── Mode local (navigateur) ──────────────────────────────────────────────────
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const DEFAULTS = {
  categories: () => ({ icon: '📦', kind: 'variable', budget: 0, position: 0, archived: false }),
  transactions: () => ({
    date: today(), category_id: null, label: null, merchant: null, source: 'manuel', fixed_key: null, kind: 'depense',
    reimbursable: false, reimbursed_at: null, reimbursed_to: null, spread_months: 1, bank: null, bank_label: null, external_id: null,
  }),
  fixed_charges: () => ({ day: 1, active: true }),
  months: () => ({ income: null, start_date: null }),
  projects: () => ({ price: null, bought: false, position: 0 }),
  accounts: () => ({ kind: 'livret', balance: 0, rate: 0, position: 0, bank: null, updated_at: new Date().toISOString() }),
  settings: () => ({
    default_income: 0, projects_total: 0, goal_start: null, goal_end: null, timezone: 'Europe/Paris', shortcut_token: newToken(),
    pay_day: 1, owner_names: null, snapshot: null, onboarded: true,
  }),
  merchant_rules: () => ({ action: 'categorie', category_id: null }),
};
const keyOf = (table, row) => (CONFLICT[table] && table !== 'transactions'
  ? CONFLICT[table].split(',').map((k) => row[k]).join('|')
  : row.id);

function localStore() {
  const KEY = 'mb.local.data';
  const USER = { id: 'local', email: 'cet appareil' };
  const load = () => storage.get(KEY) || Object.fromEntries(TABLES.map((t) => [t, []]));
  const save = (db) => storage.set(KEY, db);
  const numeric = (r) => {
    for (const f of ['amount', 'budget', 'income', 'price', 'balance', 'rate', 'default_income', 'projects_total']) {
      if (r[f] !== undefined && r[f] !== null && r[f] !== '') r[f] = Math.round(Number(r[f]) * 100) / 100;
    }
    return r;
  };
  const make = (table, row) => numeric({
    ...DEFAULTS[table](),
    ...(CONFLICT[table] && table !== 'transactions' ? {} : { id: newId() }),
    created_at: new Date().toISOString(),
    ...row,
    user_id: USER.id,
  });
  const dupFixed = (db, row) => row.fixed_key && db.transactions.some((t) => t.fixed_key === row.fixed_key && t.id !== row.id);
  const clone = (x) => JSON.parse(JSON.stringify(x));

  return {
    mode: 'local',
    async getUser() { return USER; },
    onAuth() {},
    async signIn() {}, async signUp() { return { needsConfirmation: false }; },
    async resetPassword() {}, async updatePassword() {}, async signOut() {},

    async loadAll() {
      const db = load();
      return { ...clone(db), settings: clone(db.settings[0] || null) };
    },
    async insert(table, rows) {
      const db = load();
      const out = rows.map((r) => make(table, r));
      for (const r of out) {
        if (table === 'transactions' && dupFixed(db, r)) throw new StoreError('Doublon', { code: '23505' });
        if (table === 'transactions' && r.external_id && db.transactions.some((t) => t.external_id === r.external_id)) throw new StoreError('Doublon', { code: '23505' });
        if (r.id && db[table].some((x) => x.id === r.id)) throw new StoreError('Doublon', { code: '23505' });
        db[table].push(r);
      }
      save(db);
      return clone(out);
    },
    async upsert(table, rows, { ignoreDuplicates = false } = {}) {
      const db = load();
      const out = [];
      for (const row of rows) {
        const r = { ...row, user_id: USER.id };
        let idx;
        if (table === 'transactions' && r.fixed_key) idx = db.transactions.findIndex((t) => t.fixed_key === r.fixed_key);
        else idx = db[table].findIndex((x) => keyOf(table, x) === keyOf(table, r));
        if (idx >= 0) {
          if (ignoreDuplicates) continue;
          db[table][idx] = numeric({ ...db[table][idx], ...r });
          out.push(db[table][idx]);
        } else {
          const made = make(table, r);
          db[table].push(made);
          out.push(made);
        }
      }
      save(db);
      return clone(out);
    },
    async update(table, match, patch) {
      const db = load();
      const hits = db[table].filter((x) => Object.entries(match).every(([k, v]) => x[k] === v));
      for (const h of hits) Object.assign(h, numeric({ ...patch }));
      if (table === 'transactions' && hits.some((h) => dupFixed(db, h))) throw new StoreError('Doublon', { code: '23505' });
      save(db);
      return clone(hits);
    },
    async remove(table, match) {
      const db = load();
      const gone = db[table].filter((x) => Object.entries(match).every(([k, v]) => x[k] === v));
      db[table] = db[table].filter((x) => !gone.includes(x));
      if (table === 'categories') {                      // comme les clés étrangères
        const ids = new Set(gone.map((c) => c.id));
        db.transactions.forEach((t) => { if (ids.has(t.category_id)) t.category_id = null; });
        db.fixed_charges = db.fixed_charges.filter((f) => !ids.has(f.category_id));
        db.merchant_rules = db.merchant_rules.filter((r) => !ids.has(r.category_id));
      }
      save(db);
    },
    async removeAll(table) { const db = load(); db[table] = []; save(db); },
    async rpc(name) {
      if (name === 'delete_my_account') { storage.del(KEY); return null; }
      throw new StoreError('Disponible uniquement avec un compte en ligne.');
    },
    // En local, seuls les autres onglets du même navigateur sont synchronisés.
    subscribe(onChange, onStatus) {
      const handler = (e) => { if (e.key === KEY) onChange(); };
      window.addEventListener('storage', handler);
      onStatus?.('LOCAL');
      return () => window.removeEventListener('storage', handler);
    },
  };
}
