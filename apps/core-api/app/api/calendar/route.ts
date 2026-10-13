// Lightweight calendar API — returns only calendar-tracked requirements
// Much faster than /api/compliance since it skips migration + full response building

import { NextRequest, NextResponse } from 'next/server';
// @ts-ignore — rox-node v6, externalized singleton
import Rox from 'rox-node';
import { auth } from '@/auth';
import db from '@recall/shared/db';
import { record } from '@/lib/error-metrics';
import { userFmContext, companyFmContext } from '@/lib/fm-context';

const ROUTE = 'GET /api/calendar';
/**
 * GET /api/calendar
 * Returns requirements where calendarTracking=true and dueDate is set.
 * Supports both authenticated and token-based access.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token');

    let companyId: string | null = null;

    if (session?.user?.id) {
      const user = await db
        .selectFrom('users')
        .select(['companyId'])
        .where('id', '=', session.user.id)
        .executeTakeFirst();
      companyId = user?.companyId || null;
    } else if (token) {
      const company = await db
        .selectFrom('companies')
        .select(['id'])
        .where('accessToken', '=', token)
        .executeTakeFirst();
      companyId = company?.id || null;
    }

    if (!companyId) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // FM gate — calendarView. Evaluated once the caller is known, so a target
    // group (companySize, state, email) applies to them and not to whoever the
    // server last evaluated. The browser reads the same flag to show the button.
    const flagContext = session?.user?.id
      ? await userFmContext(session.user.id, session.user.email ?? undefined)
      : await companyFmContext(companyId);
    if (!Rox.dynamicApi.isEnabled('recall.calendarView', false, flagContext)) {
      record(ROUTE, 403, 'recall.calendarView');
      return NextResponse.json(
        { error: 'Calendar view is currently disabled' },
        { status: 403 }
      );
    }

    const requirements = await db
      .selectFrom('requirements')
      .select([
        'id',
        'citation',
        'title',
        'agency',
        'status',
        'dueDate',
        'calendarTracking',
        'frequency',
      ])
      .where('companyId', '=', companyId)
      .where('calendarTracking', '=', true)
      .where('dueDate', 'is not', null)
      .where('deletedAt', 'is', null)
      .orderBy('dueDate', 'asc')
      .execute();

    return NextResponse.json({
      success: true,
      requirements,
    });
  } catch (error) {
    record(ROUTE, 500);
    console.error('[API] Calendar GET error:', error);
    return NextResponse.json(
      { error: 'Failed to load calendar data' },
      { status: 500 }
    );
  }
}
