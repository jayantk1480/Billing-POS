import { BadRequestException, Body, Controller, Get, Module, Param, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaClient } from '@pos/database';
import {
  type AvailableReports, type DashboardDto, type ReportData, reportExportQuerySchema, reportQuerySchema, type ReportSharing, type ReportType, reportTypeSchema,
  shareReportSchema,
} from '@pos/validation';
import type { Response } from 'express';
import { type AuthContext, CurrentAuth, RequirePermissions } from '../../common/auth/auth-context.js';
import { ApiZodBody, createZodDto } from '../../common/zod.js';
import { AuditService } from '../audit/audit.service.js';
import { BillingContextService } from '../billing/billing-context.js';
import { toCsv, toPdf, toXlsx } from './report-export.js';
import { ReportsService } from './reports.service.js';

class ReportQueryDto extends createZodDto(reportQuerySchema) {}
class ReportExportQueryDto extends createZodDto(reportExportQuerySchema) {}
class ShareReportDto extends createZodDto(shareReportSchema) {}

const MIME = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

function reportType(value: string): ReportType {
  const parsed = reportTypeSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Unknown report.');
  return parsed.data;
}

@ApiTags('reports')
@ApiBearerAuth()
@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  @Get('dashboard')
  @RequirePermissions('dashboard.view')
  @ApiOperation({ summary: "Today's sales, payments and recent bills" })
  dashboard(@CurrentAuth() auth: AuthContext): Promise<DashboardDto> {
    return this.reports.dashboard(auth);
  }

  @Get('reports/available')
  @ApiOperation({ summary: 'The reports the signed-in user may open' })
  available(@CurrentAuth() auth: AuthContext): Promise<AvailableReports> {
    return this.reports.available(auth);
  }

  @Get('reports/sharing')
  @RequirePermissions('report.share')
  @ApiOperation({ summary: 'Who each report is shared with' })
  sharing(@CurrentAuth() auth: AuthContext): Promise<ReportSharing> {
    return this.reports.sharing(auth);
  }

  @Put('reports/:type/sharing')
  @RequirePermissions('report.share')
  @ApiOperation({ summary: 'Set who one report is shared with' })
  @ApiZodBody(ShareReportDto)
  share(@CurrentAuth() auth: AuthContext, @Param('type') type: string, @Body() body: ShareReportDto): Promise<ReportSharing> {
    return this.reports.share(auth, reportType(type), body.userIds);
  }

  // Open to anyone signed in: the service allows a report through for report.view, or when it was shared with the caller.
  @Get('reports/:type')
  @ApiOperation({ summary: 'Run a report for a period' })
  run(@CurrentAuth() auth: AuthContext, @Param('type') type: string, @Query() query: ReportQueryDto): Promise<ReportData> {
    return this.reports.run(auth, reportType(type), query);
  }

  @Get('reports/:type/export')
  @ApiOperation({ summary: 'Download a report as CSV, Excel or PDF' })
  async export(@CurrentAuth() auth: AuthContext, @Param('type') type: string, @Query() query: ReportExportQueryDto, @Res() res: Response): Promise<void> {
    const report = await this.reports.run(auth, reportType(type), query);
    const { name } = await this.prisma.restaurant.findUniqueOrThrow({ where: { id: auth.restaurantId }, select: { name: true } });
    const file = query.format === 'csv' ? toCsv(report) : query.format === 'xlsx' ? await toXlsx(report, name) : await toPdf(report, name);
    // Sales data leaving the system is worth a line in the audit trail.
    await this.audit.record(auth, {
      action: 'report.exported', entityType: 'report', entityId: report.type,
      after: { from: query.from, to: query.to, format: query.format, rows: report.rows.length },
    });
    res.set({
      'Content-Type': MIME[query.format],
      'Content-Length': String(file.length),
      'Content-Disposition': 'attachment; filename="' + report.type + '_' + query.from + '_to_' + query.to + '.' + query.format + '"',
      'Cache-Control': 'private, no-store',
    });
    res.end(file);
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService, BillingContextService] })
export class ReportsModule {}
