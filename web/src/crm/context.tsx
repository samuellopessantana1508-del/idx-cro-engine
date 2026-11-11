import { createContext, useContext } from "react";
import type { AssistantContext } from "./assistant";
import type { AssistantPlan, CrmAccess, CrmSettings, CrmView, LossReason, Member, Offer, Pipeline, Stage } from "./types";

export type QuickCreateKind = "deal" | "contact" | "task" | "company";

export type CrmCtx = {
  tenantId: string;
  tenantName: string;
  userId: string;
  access: CrmAccess;
  members: Member[];
  pipelines: Pipeline[];
  stages: Stage[];
  lossReasons: LossReason[];
  settings: CrmSettings | null;
  offers: Offer[];
  refreshKey: number;
  notify: (msg: string) => void;
  refresh: () => void;
  reloadStructure: () => Promise<void>;
  navigate: (v: CrmView) => void;
  openDeal: (id: string) => void;
  openContact: (id: string) => void;
  quickCreate: (kind: QuickCreateKind, defaults?: Record<string, unknown>) => void;
  memberLabel: (userId: string | null | undefined) => string;
  openAssistant: (context?: AssistantContext, onApplied?: (r: { plan: AssistantPlan; contact_id: string | null; deal_id: string | null; task_id: string | null }) => void) => void;
};

export const CrmContext = createContext<CrmCtx | null>(null);

export function useCrm(): CrmCtx {
  const c = useContext(CrmContext);
  if (!c) throw new Error("CrmContext ausente");
  return c;
}
