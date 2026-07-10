import { TenantResetPassword } from "@/components/auth/tenant-reset-password";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function TenantResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const params = await searchParams;
  return <TenantResetPassword token={params.token || ""} />;
}
