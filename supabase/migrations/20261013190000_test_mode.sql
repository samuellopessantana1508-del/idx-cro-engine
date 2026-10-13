-- Add test/production mode to whatsapp_instances
ALTER TABLE public.whatsapp_instances
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'test'
  CONSTRAINT whatsapp_instances_mode_check CHECK (mode IN ('test', 'production'));

-- Index for filtering by mode
CREATE INDEX IF NOT EXISTS idx_wa_instances_mode
  ON public.whatsapp_instances (tenant_id, mode);
