-- Autorizar Arthur como colaborador
-- Execute no SQL Editor do Supabase: https://supabase.com/dashboard/project/qrguvaajioqndrruxkpi/sql/new

-- Passo 1: Verificar usuários sem perfil (para confirmar o email do Arthur)
-- SELECT u.id, u.email, u.created_at
-- FROM auth.users u
-- LEFT JOIN public.user_profiles up ON up.id = u.id
-- WHERE up.id IS NULL;

-- Passo 2: Inserir o perfil do Arthur como colaborador
INSERT INTO public.user_profiles (id, email, nome, role)
SELECT
  u.id,
  u.email,
  COALESCE(
    NULLIF(u.raw_user_meta_data ->> 'full_name', ''),
    NULLIF(u.raw_user_meta_data ->> 'name', ''),
    NULLIF(split_part(u.email, '@', 1), ''),
    'Arthur'
  ),
  'colaborador'
FROM auth.users u
LEFT JOIN public.user_profiles up ON up.id = u.id
WHERE up.id IS NULL
  AND u.email IS NOT NULL
ON CONFLICT (id) DO NOTHING;
