// ─────────────────────────────────────────────────────────────────────────────
// Connexion à ta base Supabase.
//
// Supabase → ton projet → Project Settings → API Keys :
//   • SUPABASE_URL : « Project URL »   (https://xxxxxxxx.supabase.co)
//   • SUPABASE_KEY : la clé « publishable » (sb_publishable_…) ou, sur un ancien
//                    projet, la clé « anon public ».
//
// Ces deux valeurs sont faites pour être publiques : la sécurité repose sur les
// règles RLS de schema.sql (chacun ne voit que ses propres données).
// Ne mets JAMAIS ici la clé « secret » ou « service_role ».
//
// Laissées vides, l'app demande ces infos au premier lancement (ou propose
// d'essayer en local sur l'appareil).
// ─────────────────────────────────────────────────────────────────────────────
export const SUPABASE_URL = 'https://iohcnuadffrmcgshrihu.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_1gQ_lx7gZj2znhVK_4hdTw_YErAO2Mt';
