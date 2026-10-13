// The recall.dashboardRedesign kill switch.
//
// The flag is named for the feature an audience is hoping to see. Turning it on takes
// the application away; turning it off brings it back in seconds, with no deployment.
// That is the demonstration — and it lands harder when the thing being rolled back was
// something the room actually wanted.
//
// Checked in more than one place on purpose. It was originally evaluated only on
// /api/auth/redirect, which runs once immediately after sign-in — so a refresh went
// straight to the matrix, never asked, and the user was through. A kill switch you can
// escape by pressing F5 is not a kill switch.
//
// The web UI responds to a 503 from here by ending the session and returning to the
// login page, which then refuses to let anyone back in while the flag is on. An earlier
// version left the session intact and rendered an error in place; that assumed pages
// could cope with having no data, and they could not — a 503 reached code expecting a
// payload and tripped Next's error boundary. Signing out is only a loop if the login
// page says nothing, so it says something.
//
// This deliberately does NOT live in middleware. Middleware runs on the edge runtime
// and the Feature Management server SDK is a Node library, so the flag has to be
// evaluated where the SDK actually exists.

// @ts-ignore — rox-node v6, externalized singleton
import Rox from 'rox-node';
import { userFmContext } from '@/lib/fm-context';

export const MAINTENANCE_MESSAGE =
  'Recall Tracker is temporarily unavailable. Your data is safe — please try again shortly.';

/**
 * Evaluates the kill switch AS the signed-in user.
 *
 * The context matters: a flag targeted at an email or a companySize evaluates false
 * against an SDK that has not been told who the user is, so the switch appears to do
 * nothing while looking perfectly healthy. It is passed per evaluation rather than
 * set globally — see lib/fm-context.ts.
 */
export async function isServiceKilled(userId: string, email: string): Promise<boolean> {
  return Rox.dynamicApi.isEnabled('recall.dashboardRedesign', false, await userFmContext(userId, email));
}
