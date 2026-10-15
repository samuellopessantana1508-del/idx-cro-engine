-- Expand sale signal taxonomy with new types:
-- high_intent, declared_purchase, abandonment
-- Keep legacy types (commitment, post_sale) for backward compatibility

ALTER TABLE public.sale_signals
  DROP CONSTRAINT IF EXISTS sale_signals_signal_type_check;

ALTER TABLE public.sale_signals
  ADD CONSTRAINT sale_signals_signal_type_check
  CHECK (signal_type IN (
    'interest',
    'high_intent',
    'negotiation',
    'declared_purchase',
    'confirmed_sale',
    'abandonment',
    'commitment',
    'post_sale'
  ));
