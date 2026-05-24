export const runtime = "nodejs";

export function GET() {
  return Response.json(
    {
      ok: true,
      service: "relay-api",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
