export const dynamic = "force-dynamic"

export function GET() {
  return Response.json(
    {
      status: "ok",
      service: "zhi-flow",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  )
}
