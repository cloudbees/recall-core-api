// Feature Management evaluation context for a signed-in user.
//
// Pass the result as the third argument of every server-side flag evaluation:
//
//   Rox.dynamicApi.isEnabled('recall.calendarView', false, await userFmContext(id, email))
//
// Targeting properties are never set globally on the server SDK: one process
// serves every user, so a global value belongs to whoever was evaluated last.
// See initFM() in packages/shared/src/fm/setup.ts.

import { fmContext, type FmContext } from '@recall/shared/fm';
import db from '@recall/shared/db';

export async function userFmContext(userId: string, email?: string): Promise<FmContext> {
  const user = await db
    .selectFrom('users')
    .select(['companyId'])
    .where('id', '=', userId)
    .executeTakeFirst();

  const company = user?.companyId ? await companyRow(user.companyId) : undefined;

  return fmContext({
    userId,
    email: email || undefined,
    isLoggedIn: true,
    companyId: user?.companyId ?? undefined,
    companyName: company?.companyName ?? undefined,
    employeeCount: company?.employeeCount ?? undefined,
    naicsCode: company?.naicsCode ?? undefined,
    state: company?.state ?? undefined,
  });
}

/** Context for token-based (not signed-in) access: the company, no user. */
export async function companyFmContext(companyId: string): Promise<FmContext> {
  const company = await companyRow(companyId);
  return fmContext({
    isLoggedIn: false,
    companyId,
    companyName: company?.companyName ?? undefined,
    employeeCount: company?.employeeCount ?? undefined,
    naicsCode: company?.naicsCode ?? undefined,
    state: company?.state ?? undefined,
  });
}

function companyRow(companyId: string) {
  return db
    .selectFrom('companies')
    .select(['companyName', 'employeeCount', 'naicsCode', 'state'])
    .where('id', '=', companyId)
    .executeTakeFirst();
}
