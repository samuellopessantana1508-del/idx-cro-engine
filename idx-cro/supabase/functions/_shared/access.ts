type SupabaseLike = {
  from: (table: string) => any;
};

export type TenantRole = "owner" | "admin" | "operator" | "viewer";
export type PlatformRole = "owner" | "admin" | "support" | "viewer";

function envEmailList(name: string): string[] {
  return String(Deno.env.get(name) ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export async function platformRole(
  supa: SupabaseLike,
  userId: string,
  email?: string | null,
): Promise<PlatformRole | null> {
  const emailAllowList = envEmailList("PLATFORM_OWNER_EMAILS");
  if (email && emailAllowList.includes(email.toLowerCase())) return "owner";

  const { data } = await supa
    .from("platform_users")
    .select("role")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  const role = data?.role;
  return ["owner", "admin", "support", "viewer"].includes(role) ? role : null;
}

export function canPlatformRead(role: string | null): boolean {
  return ["owner", "admin", "support", "viewer"].includes(String(role ?? ""));
}

export function canPlatformManage(role: string | null): boolean {
  return ["owner", "admin", "support"].includes(String(role ?? ""));
}

export async function canReadTenantOrPlatform(
  supa: SupabaseLike,
  tenantId: string,
  userId: string,
  email?: string | null,
): Promise<boolean> {
  const role = await platformRole(supa, userId, email);
  if (canPlatformRead(role)) return true;

  const { data } = await supa
    .from("tenant_users")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  return Boolean(data);
}

export async function canOperateTenantOrPlatform(
  supa: SupabaseLike,
  tenantId: string,
  userId: string,
  email?: string | null,
  tenantRoles: TenantRole[] = ["owner", "admin", "operator"],
): Promise<boolean> {
  const role = await platformRole(supa, userId, email);
  if (canPlatformManage(role)) return true;

  const { data } = await supa
    .from("tenant_users")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("status", "active")
    .in("role", tenantRoles)
    .maybeSingle();

  return Boolean(data);
}
