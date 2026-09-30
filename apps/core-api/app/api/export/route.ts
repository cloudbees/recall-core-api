// API endpoint for exporting compliance matrix as Excel or PDF
// GET /api/export?companyId=X&agency=FDA&format=xlsx|pdf

import { NextRequest, NextResponse } from 'next/server';
// @ts-ignore — rox-node v6, externalized singleton
import Rox from 'rox-node';
import { auth } from '@/auth';
import db from '@recall/shared/db';
import {
  getRequirementsByCompany,
  getComplianceStats,
  type RequirementFilters,
} from '@recall/shared/services/requirements';
import type { AgencyType } from '@recall/shared/db';
import ExcelJS from 'exceljs';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { record } from '@/lib/error-metrics';

const ROUTE = 'GET /api/export';

function priorityLabel(priority: number | null): string {
  switch (priority) {
    case 3: return 'High';
    case 2: return 'Medium';
    case 1: return 'Low';
    default: return '';
  }
}

function statusLabel(status: string | null): string {
  switch (status) {
    case 'compliant': return 'Compliant';
    case 'non_compliant': return 'Non-Compliant';
    case 'in_progress': return 'In Progress';
    case 'pending': return 'Pending';
    case 'n_a': return 'N/A';
    default: return 'Pending';
  }
}

function frequencyLabel(freq: string | null): string {
  switch (freq) {
    case 'annual': return 'Annual';
    case 'semi_annual': return 'Semi-Annual';
    case 'quarterly': return 'Quarterly';
    case 'monthly': return 'Monthly';
    case 'one_time': return 'One Time';
    default: return '';
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format') || 'xlsx';

    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const companyId = searchParams.get('companyId');
    const agency = searchParams.get('agency') as AgencyType | null;

    if (!companyId) {
      return NextResponse.json(
        { error: 'companyId query parameter is required' },
        { status: 400 }
      );
    }

    if (format !== 'xlsx' && format !== 'pdf') {
      return NextResponse.json(
        { error: 'format must be xlsx or pdf' },
        { status: 400 }
      );
    }

    // FM gate — exportPdf (kill switch)
    if (format === 'pdf' && !Rox.dynamicApi.isEnabled('recall.exportPdf', false)) {
      record(ROUTE, 403, 'recall.exportPdf');
      return NextResponse.json({ error: 'PDF export is currently disabled' }, { status: 403 });
    }

    // FM gate — auditExport. The server half of the gate: the browser hides the
    // menu item, and this makes the endpoint refuse anyone who calls it anyway.
    if (format === 'xlsx' && !Rox.dynamicApi.isEnabled('recall.auditExport', false)) {
      record(ROUTE, 403, 'recall.auditExport');
      return NextResponse.json({ error: 'Spreadsheet export is currently disabled' }, { status: 403 });
    }

    // Verify user owns this company
    const user = await db
      .selectFrom('users')
      .select(['companyId'])
      .where('id', '=', session.user.id)
      .executeTakeFirst();

    if (!user || user.companyId !== companyId) {
      return NextResponse.json(
        { error: 'You do not have access to this company' },
        { status: 403 }
      );
    }

    // Get company info
    const companyRow = await db
      .selectFrom('companies')
      .select(['companyName', 'naicsCode', 'employeeCount', 'state'])
      .where('id', '=', companyId)
      .executeTakeFirst();

    if (!companyRow) {
      return NextResponse.json(
        { error: 'Company not found' },
        { status: 404 }
      );
    }

    const company = {
      name: companyRow.companyName,
      naicsCode: companyRow.naicsCode,
      employeeCount: companyRow.employeeCount ?? 0,
      state: companyRow.state ?? '',
    };

    // Get requirements
    const filters: RequirementFilters = {};
    if (agency) filters.agency = agency;

    const requirements = await getRequirementsByCompany(companyId, filters);
    const stats = await getComplianceStats(companyId);

    if (format === 'xlsx') {
      return await generateExcel(requirements, company, agency, stats);
    } else {
      return generatePDF(requirements, company, agency, stats);
    }
  } catch (error) {
    record(ROUTE, 500);
    console.error('Export error:', error);
    return NextResponse.json(
      { error: 'Failed to generate export' },
      { status: 500 }
    );
  }
}

async function generateExcel(
  requirements: Awaited<ReturnType<typeof getRequirementsByCompany>>,
  company: { name: string; naicsCode: string; employeeCount: number; state: string },
  agency: string | null,
  stats: Awaited<ReturnType<typeof getComplianceStats>>
) {
  const wb = new ExcelJS.Workbook();

  // Sheet names are capped at 31 characters and cannot contain : \ / ? * [ ]
  const sheetName = agency ? `${agency} Recalls`.slice(0, 31) : 'All Recalls';
  const ws = wb.addWorksheet(sheetName);

  ws.columns = [
    { header: 'Citation',   key: 'citation',   width: 20 },
    { header: 'Title',      key: 'title',      width: 40 },
    { header: 'Agency',     key: 'agency',     width: 8 },
    { header: 'Status',     key: 'status',     width: 14 },
    { header: 'Priority',   key: 'priority',   width: 10 },
    { header: 'Confidence', key: 'confidence', width: 12 },
    { header: 'Applies To', key: 'appliesTo',  width: 50 },
    { header: 'Due Date',   key: 'dueDate',    width: 12 },
    { header: 'Frequency',  key: 'frequency',  width: 14 },
    { header: 'Notes',      key: 'notes',      width: 40 },
  ];
  ws.getRow(1).font = { bold: true };

  ws.addRows(
    requirements.map(r => ({
      citation: r.citation,
      title: r.title || r.name || '',
      agency: r.agency,
      status: statusLabel(r.status),
      priority: priorityLabel(r.priority),
      confidence: r.confidence ? `${r.confidence}%` : '',
      appliesTo: r.appliesTo || '',
      dueDate: r.dueDate ? new Date(r.dueDate).toLocaleDateString() : '',
      frequency: frequencyLabel(r.frequency || null),
      notes: r.notes || '',
    }))
  );

  // Summary sheet
  const summaryWs = wb.addWorksheet('Summary');
  summaryWs.columns = [{ width: 22 }, { width: 30 }];
  summaryWs.addRows([
    ['Product Recall Tracker Export'],
    [''],
    ['Company', company.name],
    ['NAICS Code', company.naicsCode],
    ['Employees', company.employeeCount],
    ['State', company.state],
    ['Agency Filter', agency || 'All'],
    ['Export Date', new Date().toLocaleDateString()],
    [''],
    ['Compliance Summary'],
    ['Total Recalls', stats.total],
    ['Compliant', stats.compliant],
    ['Non-Compliant', stats.nonCompliant],
    ['In Progress', stats.inProgress],
    ['Pending', stats.pending],
    ['N/A', stats.notApplicable],
    ['Compliance Rate', `${stats.complianceRate}%`],
  ]);
  summaryWs.getRow(1).font = { bold: true };
  summaryWs.getRow(10).font = { bold: true };

  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  const filename = `recall-tracker-${agency || 'all'}-${new Date().toISOString().split('T')[0]}.xlsx`;
  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

function generatePDF(
  requirements: Awaited<ReturnType<typeof getRequirementsByCompany>>,
  company: { name: string; naicsCode: string; employeeCount: number; state: string },
  agency: string | null,
  stats: Awaited<ReturnType<typeof getComplianceStats>>
) {
  const doc = new jsPDF({ orientation: 'landscape' });

  // Title
  doc.setFontSize(18);
  doc.text('Product Recall Tracker', 14, 20);

  // Company info
  doc.setFontSize(10);
  doc.text(`Company: ${company.name}`, 14, 30);
  doc.text(`NAICS: ${company.naicsCode} | Employees: ${company.employeeCount} | State: ${company.state}`, 14, 36);
  doc.text(`Agency: ${agency || 'All'} | Export Date: ${new Date().toLocaleDateString()}`, 14, 42);

  // Stats summary
  doc.setFontSize(9);
  doc.text(
    `Total: ${stats.total} | Compliant: ${stats.compliant} | Non-Compliant: ${stats.nonCompliant} | In Progress: ${stats.inProgress} | Pending: ${stats.pending} | N/A: ${stats.notApplicable} | Rate: ${stats.complianceRate}%`,
    14, 50
  );

  // Recalls table
  const tableData = requirements.map(r => [
    r.citation,
    (r.title || r.name || '').substring(0, 50),
    statusLabel(r.status),
    priorityLabel(r.priority),
    r.confidence ? `${r.confidence}%` : '',
    (r.appliesTo || '').substring(0, 60),
    r.dueDate ? new Date(r.dueDate).toLocaleDateString() : '',
    (r.notes || '').substring(0, 40),
  ]);

  autoTable(doc, {
    startY: 56,
    head: [['Citation', 'Title', 'Status', 'Priority', 'Conf.', 'Applies To', 'Due Date', 'Notes']],
    body: tableData,
    styles: { fontSize: 7, cellPadding: 2 },
    headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontSize: 8 },
    columnStyles: {
      0: { cellWidth: 28 },
      1: { cellWidth: 45 },
      2: { cellWidth: 22 },
      3: { cellWidth: 18 },
      4: { cellWidth: 14 },
      5: { cellWidth: 60 },
      6: { cellWidth: 22 },
      7: { cellWidth: 40 },
    },
    alternateRowStyles: { fillColor: [241, 245, 249] },
  });

  const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
  const filename = `recall-tracker-${agency || 'all'}-${new Date().toISOString().split('T')[0]}.pdf`;

  return new NextResponse(pdfBuffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
