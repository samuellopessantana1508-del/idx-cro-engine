-- Phase 3: AI Analyzer — conversation insights, sale signals, encrypted API key storage

-- Encrypted API key column (AES-256-GCM, recoverable for outbound calls)
ALTER TABLE public.whatsapp_instances
  ADD COLUMN IF NOT EXISTS api_key_encrypted text;

-- AI processing flag on messages
ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS ai_analyzed boolean DEFAULT false;

-- Conversation insights table — stores AI-extracted commercial intelligence
CREATE TABLE IF NOT EXISTS public.conversation_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  conversation_id uuid NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,

  extracted_name text,
  extracted_email text,
  extracted_phone text,
  extracted_address text,

  products_of_interest text[] DEFAULT '{}',
  objections text[] DEFAULT '{}',
  preferences jsonb DEFAULT '{}',
  commercial_notes text,

  summary text,
  intent text,
  sentiment text CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  purchase_probability numeric(3,2) DEFAULT 0 CHECK (purchase_probability BETWEEN 0 AND 1),
  confidence_score numeric(3,2) DEFAULT 0 CHECK (confidence_score BETWEEN 0 AND 1),

  last_analyzed_message_id uuid REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL,
  messages_analyzed_count int DEFAULT 0,
  model_used text,

  extracted_data jsonb DEFAULT '{}',
  evidence jsonb DEFAULT '{}',

  processing_basis text DEFAULT 'legitimate_interest',

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  UNIQUE (tenant_id, conversation_id)
);

-- Sale signals table — detected purchase opportunities and evidence
CREATE TABLE IF NOT EXISTS public.sale_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  conversation_id uuid NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  tracking_session_id uuid REFERENCES public.tracking_sessions(id) ON DELETE SET NULL,

  product_name text,
  product_category text,
  estimated_value numeric(12,2),
  currency text DEFAULT 'BRL',

  signal_type text NOT NULL CHECK (signal_type IN ('interest', 'negotiation', 'commitment', 'confirmed_sale', 'post_sale')),
  confidence numeric(3,2) DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  evidence_text text,
  evidence_messages jsonb DEFAULT '[]',

  status text DEFAULT 'detected' CHECK (status IN ('detected', 'confirmed', 'rejected', 'converted')),
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,

  purchase_data jsonb,
  capi_sent boolean DEFAULT false,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE public.conversation_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ci_tenant_isolation" ON public.conversation_insights
  FOR ALL USING (tenant_id IN (
    SELECT tu.tenant_id FROM public.tenant_users tu
    WHERE tu.user_id = auth.uid() AND tu.status = 'active'
  ));

CREATE POLICY "ss_tenant_isolation" ON public.sale_signals
  FOR ALL USING (tenant_id IN (
    SELECT tu.tenant_id FROM public.tenant_users tu
    WHERE tu.user_id = auth.uid() AND tu.status = 'active'
  ));

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ci_tenant ON public.conversation_insights(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ci_conversation ON public.conversation_insights(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ss_tenant ON public.sale_signals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ss_conversation ON public.sale_signals(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ss_tracking ON public.sale_signals(tracking_session_id) WHERE tracking_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ss_status ON public.sale_signals(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_wm_ai ON public.whatsapp_messages(conversation_id, ai_analyzed) WHERE ai_analyzed = false;
