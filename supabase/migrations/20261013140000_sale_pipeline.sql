-- Phase 4: Sale Pipeline — CAPI tracking on sale_signals

ALTER TABLE sale_signals
  ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS capi_event_id uuid REFERENCES capi_events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS capi_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS capi_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS capi_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS capi_error text,
  ADD COLUMN IF NOT EXISTS meta_event_id text,
  ADD COLUMN IF NOT EXISTS requires_human_confirmation boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_confirmed boolean NOT NULL DEFAULT false;

ALTER TABLE sale_signals
  ADD CONSTRAINT sale_signals_capi_status_check
  CHECK (capi_status IN ('pending', 'sending', 'success', 'failed', 'skipped'));

CREATE INDEX IF NOT EXISTS idx_sale_signals_capi_status
  ON sale_signals (tenant_id, capi_status);

CREATE INDEX IF NOT EXISTS idx_sale_signals_meta_event_id
  ON sale_signals (meta_event_id) WHERE meta_event_id IS NOT NULL;
