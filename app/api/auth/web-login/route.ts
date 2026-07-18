import { POST as login } from "@/app/api/auth/login/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Compatibility alias. New clients should use /api/auth/login.
export async function POST(request: Request) {
  return login(request);
}
