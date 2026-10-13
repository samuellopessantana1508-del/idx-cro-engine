-- Phase 6: Security audit fixes — missing GRANTs, RLS consistency, constraint guards

-- ============================================================
-- 1. Restore lost GRANTs on views dropped in migration 202606300004_crm.sql
-- ============================================================
GRANT SELECT ON public.vw_smart_link_performance TO authenticated;
GRANT SELECT ON public.vw_lead_queue TO authenticated;
GRANT SELECT ON public.vw_tenant_report TO authenticated;
GRANT SELECT ON public.vw_meta_campaign_roi TO authenticated;

-- ============================================================
-- 2. Add missing GRANTs for conversation_insights and sale_signals
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON public.conversation_insights TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.sale_signals TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.conversation_insights TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sale_signals TO service_role;

-- ============================================================
-- 3. Fix RLS policies to use idx_private.has_tenant_role() for platform admin access
-- ============================================================
DROP POLICY IF EXISTS "ci_tenant_isolation" ON public.conversation_insights;
CREATE POLICY "ci_tenant_isolation" ON public.conversation_insights
  FOR ALL USING (idx_private.has_tenant_role(tenant_id));

DROP POLICY IF EXISTS "ss_tenant_isolation" ON public.sale_signals;
CREATE POLICY "ss_tenant_isolation" ON public.sale_signals
  FOR ALL USING (idx_private.has_tenant_role(tenant_id));

-- ============================================================
-- 4. Guard against re-run: make Phase 4 constraint idempotent
-- ============================================================
ALTER TABLE public.sale_signals
  DROP CONSTRAINT IF EXISTS sale_signals_capi_status_check;
ALTER TABLE public.sale_signals
  ADD CONSTRAINT sale_signals_capi_status_check
  CHECK (capi_status IN ('pending', 'sending', 'success', 'failed', 'skipped'));

-- ============================================================
-- 5. Drop redundant ASC index (DESC index already covers these queries)
-- ============================================================
DROP INDEX IF EXISTS idx_tracking_sessions_clicked_at;

-- ============================================================
-- 6. Add unique constraint to prevent duplicate sale signals per conversation
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_signals_conversation_dedup
  ON public.sale_signals (tenant_id, conversation_id, signal_type)
  WHERE status IN ('detected', 'confirmed');
