// Public by design — the anon key is meant to be embedded in client-side
// code exactly like this; every table/RPC behind it is already gated by
// RLS and the explicit grants set up in the Flutter app's Supabase
// migrations (supabase/migrations/20260916000*.sql in the mubrram repo).
// This is NOT the service_role key and must never be.
const SUPABASE_URL = 'https://tjnbrwpziyjvucxbsnoj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_6z--Xi-jrl2f4a1Ir2tN9g_FHyWaCgV';
