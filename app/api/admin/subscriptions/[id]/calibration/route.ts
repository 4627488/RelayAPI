import { errorToResponse } from "@/src/server/http/errors";
import { requireWebRequest } from "@/src/server/services/webAccess";
import { getSubscriptionCalibrationTask, scheduleSubscriptionCalibration } from "@/src/server/services/subscriptionQuotaCalibration";

export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { requireWebRequest(request); return Response.json(getSubscriptionCalibrationTask((await context.params).id)); } catch (error) { return errorToResponse(error); } }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { try { requireWebRequest(request); return Response.json(scheduleSubscriptionCalibration((await context.params).id), { status: 202 }); } catch (error) { return errorToResponse(error); } }
