import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function mustExist(path) {
  assert.equal(existsSync(join(root, path)), true, `${path} should exist`);
}

[
  "supabase/functions/go/index.ts",
  "supabase/functions/convert/index.ts",
  "supabase/functions/capi-health/index.ts",
  "supabase/functions/tenant-admin/index.ts",
  "supabase/functions/meta-oauth/index.ts",
  "supabase/functions/meta-assets/index.ts",
  "supabase/functions/supabase-health/index.ts",
  "supabase/functions/meta-insights/index.ts",
  "supabase/functions/meta-audiences/index.ts",
  "supabase/functions/_shared/access.ts",
  "supabase/functions/_shared/meta-audiences.ts",
  "supabase/functions/crm/index.ts",
].forEach(mustExist);

const migration1 = read("supabase/migrations/202606300001_init.sql");
const migration2 = read("supabase/migrations/202606300002_integrations_onboarding.sql");
const migration3 = read("supabase/migrations/202606300003_meta_ads_insights.sql");
const migration4 = read("supabase/migrations/202606300004_crm.sql");
const migration5 = read("supabase/migrations/202607010001_platform_control.sql");
const migration7 = read("supabase/migrations/20260701112934_tenant_user_profiles.sql");
const migration8 = read("supabase/migrations/20260701143000_meta_custom_audiences.sql");
const migration9 = read("supabase/migrations/20260702125744_tenant_onboarding_company_profile.sql");
const migration10 = read("supabase/migrations/20260705010424_invalid_link_events.sql");
const config = read("supabase/config.toml");
const go = read("supabase/functions/go/index.ts");
const convert = read("supabase/functions/convert/index.ts");
const capi = read("supabase/functions/capi-health/index.ts");
const tenantAdmin = read("supabase/functions/tenant-admin/index.ts");
const metaOauth = read("supabase/functions/meta-oauth/index.ts");
const metaAssets = read("supabase/functions/meta-assets/index.ts");
const metaInsights = read("supabase/functions/meta-insights/index.ts");
const metaAudiences = read("supabase/functions/meta-audiences/index.ts");
const sharedAccess = read("supabase/functions/_shared/access.ts");
const sharedMetaAudiences = read("supabase/functions/_shared/meta-audiences.ts");
const crm = read("supabase/functions/crm/index.ts");
const supabaseHealth = read("supabase/functions/supabase-health/index.ts");

assert.match(migration1, /create table public\.tenants/);
assert.match(migration1, /create table public\.smart_links/);
assert.match(migration1, /create table public\.tracking_sessions/);
assert.match(migration1, /create table public\.tenant_meta_credentials/);
assert.match(migration1, /enable row level security/);
assert.match(migration2, /integration_oauth_states/);
assert.match(migration2, /tenant_onboarding/);
assert.match(migration2, /tenant_invites/);
assert.match(migration2, /vw_tenant_report/);
assert.match(migration3, /meta_campaign_insights/);
assert.match(migration3, /vw_meta_campaign_roi/);
assert.match(migration4, /crm_activities/);
assert.match(migration4, /qualified/);
assert.match(migration4, /vw_remarketing_audience/);
assert.match(migration4, /remarketing_leads/);
assert.match(migration5, /create table if not exists public\.platform_users/);
assert.match(migration5, /create table if not exists public\.platform_audit_log/);
assert.match(migration5, /idx_private\.is_platform_user/);
assert.match(migration5, /idx_private\.has_tenant_role/);
assert.match(migration5, /vw_tenant_isolation_audit/);
assert.match(migration7, /add column if not exists email text/);
assert.match(migration7, /idx_tenant_users_tenant_email/);
assert.match(migration8, /meta_custom_audiences/);
assert.match(migration8, /meta_audience_syncs/);
assert.match(migration8, /vw_meta_audience_status/);
assert.match(migration8, /USER_PROVIDED_ONLY/);
assert.match(migration9, /business_segment/);
assert.match(migration9, /monthly_goal/);
assert.match(migration9, /average_ticket/);
assert.match(migration10, /create table if not exists public\.invalid_link_events/);
assert.match(migration10, /enable row level security/);
assert.match(migration10, /service_role/);
assert.match(migration10, /vw_invalid_link_health/);

assert.match(config, /\[functions\.go\][\s\S]*verify_jwt = false/);
assert.match(config, /\[functions\.convert\][\s\S]*verify_jwt = true/);
assert.match(config, /\[functions\.meta-oauth\]/);
assert.match(config, /\[functions\.meta-insights\][\s\S]*verify_jwt = true/);
assert.match(config, /\[functions\.crm\][\s\S]*verify_jwt = true/);
assert.match(config, /\[functions\.meta-audiences\][\s\S]*verify_jwt = true/);

assert.match(go, /Response\.redirect\(targetUrl/);
assert.match(go, /event_name: "Lead"/);
assert.match(go, /tenant_meta_credentials/);
assert.match(go, /invalidLinkResponse/);
assert.match(go, /ALLOW_INVALID_LINK_FALLBACK/);
assert.match(go, /logInvalidLink/);
assert.match(go, /invalid_link_events/);
assert.match(go, /isPreviewCrawler/);
assert.match(go, /isMetaPreviewIp/);
assert.match(go, /facebookexternalhit/);
assert.match(go, /meta-externalfetcher/);
assert.match(go, /173\.252\./);
assert.doesNotMatch(go, /go\.idx\.app/);

assert.match(convert, /event_name: "Purchase"/);
assert.match(convert, /lead_status: "sold"/);
assert.match(convert, /tenant_meta_credentials/);
assert.match(convert, /canOperateTenantOrPlatform/);
assert.match(convert, /contact_match_not_found/);
assert.match(convert, /ambiguous_contact_match/);
assert.match(convert, /match_strategy/);

assert.match(capi, /req\.method === "POST"/);
assert.match(capi, /test_event_code/);
assert.match(capi, /external_id/);
assert.match(capi, /client_ip_address/);
assert.match(capi, /requestPayload/);
assert.doesNotMatch(capi, /request_payload: payload/);
assert.match(capi, /tenant_meta_credentials/);
assert.match(capi, /canReadTenantOrPlatform/);
assert.match(capi, /canOperateTenantOrPlatform/);

assert.match(tenantAdmin, /create_tenant/);
assert.match(tenantAdmin, /action === "bootstrap"/);
assert.match(tenantAdmin, /platform_role/);
assert.match(tenantAdmin, /vw_tenant_isolation_audit/);
assert.match(tenantAdmin, /save_meta_manual/);
assert.match(tenantAdmin, /invite_user/);
assert.match(tenantAdmin, /inviteUserByEmail/);
assert.match(tenantAdmin, /tenant_users"\)\.upsert/);
assert.match(tenantAdmin, /onConflict: "tenant_id,user_id"/);
assert.match(tenantAdmin, /PLATFORM_OWNER_EMAILS/);
assert.match(tenantAdmin, /REQUIRE_PLATFORM_ADMIN_FOR_TENANT_CREATE/);
assert.match(tenantAdmin, /platform_audit_log/);
assert.match(tenantAdmin, /business_segment/);
assert.match(tenantAdmin, /monthly_goal/);
assert.match(tenantAdmin, /average_ticket/);

assert.match(metaOauth, /dialog\/oauth/);
assert.match(metaOauth, /META_LOGIN_CONFIG_ID/);
assert.match(metaOauth, /config_id/);
assert.doesNotMatch(metaOauth, /"email"/);
assert.match(metaOauth, /autoSelectMetaAssets/);
assert.match(metaOauth, /selected_ad_account_id/);
assert.match(metaOauth, /oauth\/access_token/);
assert.match(metaOauth, /integration_oauth_states/);
assert.match(metaOauth, /tenant_meta_credentials/);
assert.match(metaOauth, /https:\/\/idxparasuaempresa\.com\.br/);
assert.match(metaOauth, /canOperateTenantOrPlatform/);
assert.doesNotMatch(metaOauth, /localhost:5177/);

assert.match(metaAssets, /me\/adaccounts/);
assert.match(metaAssets, /adspixels/);
assert.match(metaAssets, /selected_ad_account_id/);
assert.match(metaAssets, /normalizeActId/);
assert.match(metaAssets, /missing_meta_asset_selection/);
assert.match(metaAssets, /canOperateTenantOrPlatform/);

assert.match(metaInsights, /\/insights/);
assert.match(metaInsights, /vw_meta_campaign_roi/);
assert.match(metaInsights, /meta_campaign_insights/);
assert.match(metaInsights, /canReadTenantOrPlatform/);
assert.match(metaInsights, /canOperateTenantOrPlatform/);

assert.match(metaAudiences, /ensureMetaAudience/);
assert.match(metaAudiences, /syncTenantAudience/);
assert.match(metaAudiences, /vw_meta_audience_status/);
assert.match(metaAudiences, /canReadTenantOrPlatform/);
assert.match(metaAudiences, /canOperateTenantOrPlatform/);

assert.match(sharedAccess, /platform_users/);
assert.match(sharedAccess, /PLATFORM_OWNER_EMAILS/);
assert.match(sharedAccess, /canPlatformRead/);
assert.match(sharedAccess, /canPlatformManage/);
assert.match(sharedAccess, /tenant_users/);

assert.match(sharedMetaAudiences, /customaudiences/);
assert.match(sharedMetaAudiences, /PHONE_SHA256/);
assert.match(sharedMetaAudiences, /EMAIL_SHA256/);
assert.match(sharedMetaAudiences, /meta_audience_syncs/);

assert.match(crm, /QualifiedLead/);
assert.match(crm, /DisqualifiedLead/);
assert.match(crm, /crm_activities/);
assert.match(crm, /remarketing/);
assert.match(crm, /contact_changed/);
assert.match(crm, /tenant_meta_credentials/);
assert.match(crm, /syncSessionToMetaAudience/);
assert.match(crm, /canOperateTenantOrPlatform/);

assert.match(supabaseHealth, /single_owned_multi_tenant/);
assert.match(supabaseHealth, /tenant_id \+ rls \+ edge_functions/);
assert.match(supabaseHealth, /platform_users/);
assert.match(supabaseHealth, /invalid_link_events/);

console.log("Edge function contract tests passed.");
