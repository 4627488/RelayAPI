import { TenantActivate } from "@/components/auth/tenant-activate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function TenantActivatePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;
  return <TenantActivate token={params.token || ""} />;
}
