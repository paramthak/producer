import { NextResponse } from "next/server";
import { getStatus } from "@/lib/googleDrive";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getStatus());
}
