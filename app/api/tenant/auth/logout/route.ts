import { POST as logout } from "@/app/api/auth/logout/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Compatibility alias. New clients should use /api/auth/logout.
export async function POST(request: Request) {
  return logout(request);
}
