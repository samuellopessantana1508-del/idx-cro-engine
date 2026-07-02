import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

function createSupabaseClient() {
  if (!url || !anon) return null;

  try {
    return createClient(url, anon, { auth: { persistSession: true } });
  } catch (error) {
    console.error("Configuracao Supabase invalida.", error);
    return null;
  }
}

export const supabase = createSupabaseClient();
