-- ─────────────────────────────────────────────────────────────────────────────
-- Mon Budget — schéma de la base Supabase
--
-- À exécuter UNE fois : Supabase → SQL Editor → New query → coller ce fichier → Run.
-- Le script est ré-exécutable sans risque (il ne supprime aucune donnée).
--
-- Chaque table porte un user_id et une règle RLS « chacun ne voit que ses lignes » :
-- plusieurs personnes peuvent utiliser la même base sans jamais voir les données
-- des autres.
-- ─────────────────────────────────────────────────────────────────────────────

-- Catégories de dépenses (Loyer, Courses, Bar…) avec leur budget mensuel
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  icon        text not null default '📦' check (char_length(icon) <= 16),
  kind        text not null default 'variable' check (kind in ('fixe', 'variable', 'epargne')),
  budget      numeric(12, 2) not null default 0 check (budget >= 0),
  position    int not null default 0,
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Dépenses
create table if not exists public.transactions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date         date not null default current_date,
  amount       numeric(12, 2) not null check (amount >= 0 and amount <= 1000000),
  category_id  uuid references public.categories (id) on delete set null,
  label        text check (char_length(label) <= 120),
  merchant     text check (char_length(merchant) <= 120),
  source       text not null default 'manuel' check (source in ('manuel', 'raccourci', 'fixe', 'import')),
  fixed_key    text,          -- « <id charge fixe>:<AAAA-MM> » : empêche les doublons
  created_at   timestamptz not null default now(),
  unique (user_id, fixed_key)
);
create index if not exists transactions_user_date on public.transactions (user_id, date);

-- Charges fixes ajoutées automatiquement chaque mois (loyer, abonnements…)
create table if not exists public.fixed_charges (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category_id  uuid not null references public.categories (id) on delete cascade,
  label        text not null check (char_length(label) between 1 and 60),
  amount       numeric(12, 2) not null check (amount >= 0),
  day          int not null default 1 check (day between 1 and 28),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Revenus de chaque mois (AAAA-MM)
create table if not exists public.months (
  user_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  month    text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  income   numeric(12, 2) not null default 0 check (income >= 0),
  primary key (user_id, month)
);

-- Projets pour lesquels on épargne
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  price       numeric(12, 2) check (price >= 0),
  bought      boolean not null default false,
  position    int not null default 0,
  created_at  timestamptz not null default now()
);

-- Comptes et livrets (Livret A, PEL, compte courant…)
create table if not exists public.accounts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  kind        text not null default 'livret' check (kind in ('courant', 'livret', 'pel', 'assurance_vie', 'bourse', 'autre')),
  balance     numeric(14, 2) not null default 0,
  rate        numeric(6, 3) not null default 0 check (rate between -10 and 100),
  position    int not null default 0,
  updated_at  timestamptz not null default now()
);

-- Réglages (une ligne par personne)
create table if not exists public.settings (
  user_id         uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  default_income  numeric(12, 2) not null default 0 check (default_income >= 0),
  projects_total  numeric(12, 2) not null default 0 check (projects_total >= 0),
  goal_start      text check (goal_start ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  goal_end        text check (goal_end ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  timezone        text not null default 'Europe/Paris',
  shortcut_token  text not null unique
                  default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  created_at      timestamptz not null default now()
);

-- « Ce commerçant va dans cette catégorie » (appris quand on classe une dépense)
create table if not exists public.merchant_rules (
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  merchant     text not null,         -- en minuscules
  category_id  uuid not null references public.categories (id) on delete cascade,
  primary key (user_id, merchant)
);

-- ── Version 2 : mois de paie, import de relevés, lissage, remboursements ───
-- (ajouts ré-exécutables : rien n'est supprimé)
alter table public.transactions add column if not exists kind text not null default 'depense';
alter table public.transactions add column if not exists reimbursable boolean not null default false;
alter table public.transactions add column if not exists reimbursed_at date;
alter table public.transactions add column if not exists reimbursed_to text;
alter table public.transactions add column if not exists spread_months int not null default 1;
alter table public.transactions add column if not exists bank text;
alter table public.transactions add column if not exists bank_label text;
alter table public.transactions add column if not exists external_id text;

alter table public.months add column if not exists start_date date;
alter table public.months alter column income drop not null;
alter table public.months alter column income drop default;

alter table public.settings add column if not exists pay_day int not null default 1;
alter table public.settings add column if not exists owner_names text;
alter table public.settings add column if not exists snapshot jsonb;
alter table public.settings add column if not exists onboarded boolean not null default true;

alter table public.merchant_rules add column if not exists action text not null default 'categorie';
alter table public.merchant_rules alter column category_id drop not null;

alter table public.accounts add column if not exists bank text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_kind_check') then
    alter table public.transactions add constraint transactions_kind_check check (kind in ('depense', 'revenu', 'ignore'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_reimbursed_to_check') then
    alter table public.transactions add constraint transactions_reimbursed_to_check check (reimbursed_to in ('epargne', 'budget'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_spread_check') then
    alter table public.transactions add constraint transactions_spread_check check (spread_months between 1 and 36);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_bank_label_check') then
    alter table public.transactions add constraint transactions_bank_label_check check (char_length(bank_label) <= 300);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_user_external_key') then
    alter table public.transactions add constraint transactions_user_external_key unique (user_id, external_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'settings_pay_day_check') then
    alter table public.settings add constraint settings_pay_day_check check (pay_day between 1 and 31);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'merchant_rules_action_check') then
    alter table public.merchant_rules add constraint merchant_rules_action_check check (action in ('categorie', 'ignorer', 'rembourse'));
  end if;
end $$;

-- Ancienne version du raccourci (remplacée plus bas)
drop function if exists public.add_from_shortcut(text, text, text, text);

-- ── Sécurité : chacun ne lit et n'écrit que ses propres lignes ─────────────
do $$
declare t text;
begin
  foreach t in array array['categories', 'transactions', 'fixed_charges', 'months',
                           'projects', 'accounts', 'settings', 'merchant_rules']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ── Synchronisation en direct entre appareils (Supabase Realtime) ──────────
-- Une dépense ajoutée sur l'iPhone apparaît aussitôt sur le Mac, et inversement.
-- Les règles RLS s'appliquent : chacun ne reçoit que les changements de ses données.
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['categories', 'transactions', 'fixed_charges', 'months',
                             'projects', 'accounts', 'settings', 'merchant_rules']
    loop
      if not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ── Raccourci iPhone : ajoute une dépense à partir d'un paiement Apple Pay ──
-- Appelée sans être connecté, avec le jeton secret propre à chaque personne
-- (Réglages → Raccourci iPhone). Le montant arrive en texte (« 12,50 € »).
-- Renvoie un message prêt à afficher en notification :
--   « 18,00 € → Bar / resto · il te reste 140,00 € ce mois-ci · ⚠️ Bar / resto : budget dépassé de 12,00 € »

-- Même normalisation que ruleKey() dans bank.js
create or replace function public.mb_key(p text) returns text
language sql immutable as $$
  select left(btrim(regexp_replace(regexp_replace(
    translate(lower(coalesce(p, '')), 'àâäáãåçéèêëíìîïñóòôöõúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'),
    '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g')), 120)
$$;

-- Commerçants courants → nom de catégorie (même liste que bank.js)
create or replace function public.mb_builtin_category(p_merchant text) returns text
language sql immutable as $$
  select case
    when m ~ '\y(ESCOTA|ASF|APRR|SANEF|AREA|COFIROUTE|VINCI AUTOROUTES?|SMTPC|TUNNEL|PEAGE|TOTAL ?ENERGIES|TOTAL ACCESS|ESSO|SHELL|AVIA|STATION|CARBURANT|BP)\y' then 'Péage + essence'
    when m ~ '\y(CARREFOUR|LECLERC|AUCHAN|LIDL|ALDI|MONOPRIX|FRANPRIX|CASINO|INTERMARCHE|SUPER U|HYPER U|U EXPRESS|SPAR|PICARD|GRAND FRAIS|NETTO|COCCINELLE|BIOCOOP|NATURALIA|PROXI|VIVAL|G20|BOULANG\w*|PAIN)\y' then 'Courses'
    when m ~ '\y(BAR|CAFE|BRASSERIE|RESTAU\w*|PIZZ\w*|BURGER\w*|KEBAB|SUSHI|MCDO\w*|MC DONALD\w*|KFC|UBER ?EATS|DELIVEROO|BISTRO\w*|PUB|FIZZ|BRUNCH|TRAITEUR)\y' then 'Bar / resto'
    when m ~ '\y(SNCF|OUIGO|TGV|RTM|RATP|LIME|BOLT|UBER|BLABLACAR|EFFIA|INDIGO|PARKING|NAVIGO|TRANSAVIA|EASYJET|RYANAIR|AIR FRANCE|VOLOTEA)\y' then 'Transport'
    when m ~ '\y(PHARMACIE|PHARMA\w*|MEDECIN|DOCTEUR|DR|LABORATOIRE|LABO|OPTIC\w*|DENTISTE|KINE\w*|HOPITAL|CLINIQUE|RADIOLOGIE)\y' then 'Santé'
    when m ~ '\y(APPLE\.?COM|NETFLIX|SPOTIFY|DEEZER|CANAL|PRIME VIDEO|AMAZON PRIME|DISNEY|ANTHROPIC|CLAUDE\.?AI|FREE MOBILE|SFR|ORANGE|BOUYGUES|SOSH|RED BY SFR|ICLOUD|GOOGLE ?ONE|YOUTUBE)\y' then 'Abonnements'
    when m ~ '\y(DECATHLON|BASIC ?FIT|FITNESS|GO SPORT|INTERSPORT|ON AIR|KEEP COOL|CLIMB\w*|ESCALADE|PISCINE)\y' then 'Sport'
    when m ~ '\y(ZARA|H ?& ?M|UNIQLO|KIABI|CELIO|JULES|NIKE|ADIDAS|BERSHKA|PULL ?& ?BEAR|VINTED|LA HALLE|PRIMARK|SNIPES|COURIR|JD SPORTS|GALERIES LAFAYETTE|PRINTEMPS)\y' then 'Vêtements'
    when m ~ '\y(COIFF\w*|BARBER\w*|SALON DE COIFFURE)\y' then 'Coiffeur'
    when m ~ '\y(FDJ|SHOTGUN|CINEMA|PATHE|UGC|GAUMONT|FNAC|CULTURA|TICKETMASTER|BILLETTERIE|ARENES|HOTEL|AIRBNB|BOOKING|MUSEE|STEAM|PLAYSTATION|NINTENDO|BOWLING|KARTING|LASER)\y' then 'Loisirs'
  end
  from (select ' ' || upper(translate(coalesce(p_merchant, ''), 'àâäáãåçéèêëíìîïñóòôöõúùûüýÿÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ', 'aaaaaaceeeeiiiinooooouuuuyyAAAEEEEIIOOUUUC')) || ' ' as m) s
$$;

create or replace function public.mb_euros(n numeric) returns text
language sql immutable as $$
  select replace(to_char(round(n, 2), 'FM999999990.00'), '.', ',') || ' €'
$$;

create or replace function public.add_from_shortcut(
  p_token    text,
  p_amount   text,
  p_merchant text default null,
  p_card     text default null
) returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user      uuid;
  v_tz        text;
  v_snap      jsonb;
  v_today     date;
  v_clean     text;
  v_amount    numeric;
  v_merchant  text := nullif(btrim(coalesce(p_merchant, '')), '');
  v_cat       uuid;
  v_catname   text;
  v_action    text;
  v_kind      text := 'depense';
  v_reimb     boolean := false;
  v_start     date;
  v_end       date;
  v_since     numeric;
  v_remaining numeric;
  v_cat_budget numeric;
  v_cat_spent numeric;
  v_msg       text;
begin
  if p_token is null or char_length(p_token) < 32 then
    raise exception 'jeton invalide' using errcode = '28000';
  end if;
  select user_id, timezone, snapshot into v_user, v_tz, v_snap from settings where shortcut_token = p_token;
  if v_user is null then
    raise exception 'jeton invalide' using errcode = '28000';
  end if;
  v_today := (now() at time zone coalesce(v_tz, 'Europe/Paris'))::date;

  -- « 1 234,56 € » → 1234.56   ·   « €12.50 » → 12.50   ·   « -8,00 » → 8.00
  v_clean := regexp_replace(coalesce(p_amount, ''), '[^0-9,.]', '', 'g');
  v_clean := replace(v_clean, ',', '.');
  v_clean := regexp_replace(v_clean, '\.(?=.*\.)', '', 'g');
  if v_clean !~ '^\d+(\.\d+)?$' then
    raise exception 'montant illisible : %', p_amount using errcode = '22023';
  end if;
  v_amount := round(v_clean::numeric, 2);
  if v_amount <= 0 or v_amount > 1000000 then
    raise exception 'montant hors limites : %', p_amount using errcode = '22023';
  end if;

  if v_merchant is not null then
    v_merchant := left(v_merchant, 120);
    -- 1. règle apprise pour ce commerçant
    select r.action, r.category_id, c.name into v_action, v_cat, v_catname
      from merchant_rules r left join categories c on c.id = r.category_id and not c.archived
     where r.user_id = v_user and r.merchant = mb_key(v_merchant);
    if v_action = 'ignorer' then v_kind := 'ignore'; v_cat := null; v_catname := null;
    elsif v_action = 'rembourse' then v_reimb := true;
    end if;
    -- 2. sinon, commerçant courant reconnu
    if v_action is null then
      select id, name into v_cat, v_catname from categories
       where user_id = v_user and not archived and mb_key(name) = mb_key(mb_builtin_category(v_merchant))
       limit 1;
    end if;
  end if;

  insert into transactions (user_id, date, amount, category_id, merchant, source, kind, reimbursable)
  values (v_user, v_today, v_amount, v_cat, v_merchant, 'raccourci', v_kind, v_reimb);

  -- Message pour la notification
  v_msg := mb_euros(v_amount) || ' → ' || coalesce(v_catname, 'À classer');
  if v_kind = 'ignore' then v_msg := v_msg || ' (ignoré)'; end if;
  if v_reimb then v_msg := v_msg || ' (remboursement attendu)'; end if;

  if v_snap is not null and v_kind = 'depense' and not v_reimb then
    v_start := (v_snap->>'start')::date;
    v_end := (v_snap->>'end')::date;
    if v_today between v_start and v_end then
      select coalesce(sum(amount), 0) into v_since from transactions
       where user_id = v_user and created_at > (v_snap->>'at')::timestamptz
         and kind = 'depense' and not reimbursable and spread_months = 1
         and date between v_start and v_end;
      v_remaining := (v_snap->>'remaining')::numeric - v_since;
      v_msg := v_msg || case when v_remaining >= 0
        then ' · il te reste ' || mb_euros(v_remaining) || ' ce mois-ci'
        else ' · budget du mois dépassé de ' || mb_euros(-v_remaining) end;
      if v_cat is not null and (v_snap->'cats') ? v_cat::text then
        v_cat_budget := coalesce((v_snap->'cats'->v_cat::text->>'b')::numeric, 0);
        select coalesce(sum(amount), 0) into v_since from transactions
         where user_id = v_user and category_id = v_cat and created_at > (v_snap->>'at')::timestamptz
           and kind = 'depense' and not reimbursable and spread_months = 1 and date between v_start and v_end;
        v_cat_spent := coalesce((v_snap->'cats'->v_cat::text->>'s')::numeric, 0) + v_since;
        if v_cat_budget > 0 and v_cat_spent > v_cat_budget then
          v_msg := v_msg || ' · ⚠️ ' || v_catname || ' : budget dépassé de ' || mb_euros(v_cat_spent - v_cat_budget);
        end if;
      end if;
    end if;
  end if;

  return json_build_object('ok', true, 'message', v_msg, 'montant', v_amount,
                           'categorie', coalesce(v_catname, 'À classer'), 'reste', v_remaining);
end $$;

revoke all on function public.add_from_shortcut(text, text, text, text) from public;
grant execute on function public.add_from_shortcut(text, text, text, text) to anon, authenticated;

-- ── Supprimer son compte et toutes ses données (Réglages → Supprimer mon compte) ──
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'non connecté' using errcode = '28000';
  end if;
  delete from auth.users where id = auth.uid();   -- tout le reste suit (on delete cascade)
end $$;

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;
