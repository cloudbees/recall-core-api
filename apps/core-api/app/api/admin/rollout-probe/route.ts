// GET /api/admin/rollout-probe?flag=recall.exportPdf&samples=200
//
// Measures a progressive rollout instead of reading it.
//
// CloudBees does not expose the rollout percentage: not through the flag API,
// not in a connected configuration-as-code repository, and not reachably through
// the SDK's configuration endpoint. That was established and abandoned once
// already. So this endpoint works the problem from the other side — it asks the
// real SDK the real question N times and counts the answers.
//
// DEPENDS ON PER-EVALUATION BUCKETING. A percentage rollout on the server SDK
// splits each evaluation independently rather than sticking per user, because the
// bucket is an md5 of the stickiness property and `rox.distinct_id` is a device
// property that means nothing in a process serving everyone. See
// unify-findings.md. If CloudBees ever makes server-side evaluation sticky, this
// returns 0 or `samples` and nothing in between, and the Rollout page goes
// all-or-nothing rather than subtly wrong.
//
// Node runtime: the server SDK is a Node library, as with the other flag reads.

import { NextResponse } from 'next/server';
// @ts-ignore — rox-node v6, externalized singleton
import Rox from 'rox-node';
import { checkAdminAuth } from '@/lib/admin-auth';

export const runtime = 'nodejs';

// Same list the telemetry endpoint reports. Restricting it matters: an arbitrary
// flag name would turn this into a way to enumerate an organisation's flags, and
// a large `samples` would turn it into a cheap way to burn CPU.
const ALLOWED = [
  'recall.dashboardRedesign',
  'recall.recallAdvisor',
  'recall.exportPdf',
  'recall.calendarView',
] as const;

const MAX_SAMPLES = 1000;

export async function GET(request: Request) {
  const auth = checkAdminAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const url = new URL(request.url);
  const flag = url.searchParams.get('flag') ?? ALLOWED[0];
  if (!(ALLOWED as readonly string[]).includes(flag)) {
    return NextResponse.json(
      { error: `flag must be one of: ${ALLOWED.join(', ')}` },
      { status: 400 }
    );
  }

  const requested = Number(url.searchParams.get('samples') ?? 200);
  const samples = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_SAMPLES)
    : 200;

  // Each call is a full evaluation against the configuration the SDK currently
  // holds — the same call the real gates make, minus the work that follows it.
  let enabled = 0;
  const pattern: boolean[] = [];
  for (let i = 0; i < samples; i++) {
    const on = Rox.dynamicApi.isEnabled(flag, false);
    pattern.push(on);
    if (on) enabled++;
  }

  const fmReady = !!process.env.FM_KEY && process.env.FM_KEY !== 'unset';

  return NextResponse.json(
    {
      flag,
      samples,
      enabled,
      // Returned so the grid shows the actual answers rather than a reshuffle of
      // the count. Order carries no meaning — there is no user behind a cell.
      pattern,
      // Without a key every flag reads as its code default, which would render as
      // a uniformly "off" grid and look like a rollout set to zero.
      fmReady,
      at: Date.now(),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
