import {
  Body, type CanActivate, Controller, Delete, type ExecutionContext, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaClient } from '@pos/database';
import type { BridgeJob } from '@pos/types';
import {
  type BridgeCreatedDto, type BridgeDto, bridgeHelloSchema, bridgeResultSchema, createBridgeSchema, type Page, type PrinterDto, printerSchema, type PrintingStatusDto,
  type PrintJobDto, printJobQuerySchema, type PrintLayoutsDto, updatePrinterSchema, updatePrintLayoutsSchema,
} from '@pos/validation';
import type { Request } from 'express';
import { type AuthContext, CurrentAuth, Public, RequirePermissions } from '../../common/auth/auth-context.js';
import { ApiZodBody, createZodDto } from '../../common/zod.js';
import { PrintQueueService } from './print-queue.service.js';
import { hashBridgeToken, PrintingService } from './printing.service.js';

class PrinterDtoIn extends createZodDto(printerSchema) {}
class UpdatePrinterDto extends createZodDto(updatePrinterSchema) {}
class UpdateLayoutsDto extends createZodDto(updatePrintLayoutsSchema) {}
class CreateBridgeDto extends createZodDto(createBridgeSchema) {}
class PrintJobQueryDto extends createZodDto(printJobQuerySchema) {}
class BridgeHelloDto extends createZodDto(bridgeHelloSchema) {}
class BridgeResultDto extends createZodDto(bridgeResultSchema) {}

@ApiTags('printing')
@ApiBearerAuth()
@Controller()
export class PrintingController {
  constructor(
    private readonly printing: PrintingService,
    private readonly queue: PrintQueueService,
  ) {}

  @Get('printing/status')
  @ApiOperation({ summary: 'Whether bills and kitchen tickets can print through the bridge right now' })
  status(@CurrentAuth() auth: AuthContext): Promise<PrintingStatusDto> {
    return this.printing.status(auth);
  }

  @Get('printers')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'List printers' })
  listPrinters(@CurrentAuth() auth: AuthContext): Promise<PrinterDto[]> {
    return this.printing.listPrinters(auth);
  }

  @Post('printers')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Add a printer' })
  @ApiZodBody(PrinterDtoIn)
  createPrinter(@CurrentAuth() auth: AuthContext, @Body() body: PrinterDtoIn): Promise<PrinterDto> {
    return this.printing.createPrinter(auth, body);
  }

  @Patch('printers/:id')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Change a printer' })
  @ApiZodBody(UpdatePrinterDto)
  updatePrinter(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdatePrinterDto): Promise<PrinterDto> {
    return this.printing.updatePrinter(auth, id, body);
  }

  @Delete('printers/:id')
  @RequirePermissions('settings.manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a printer' })
  deletePrinter(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.printing.deletePrinter(auth, id);
  }

  @Post('printers/:id/test')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Print a test page' })
  test(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<PrintJobDto> {
    return this.queue.testPrint(auth, id);
  }

  @Get('print-layouts')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'What is printed on bills and kitchen tickets' })
  layouts(@CurrentAuth() auth: AuthContext): Promise<PrintLayoutsDto> {
    return this.printing.layouts(auth.restaurantId);
  }

  @Patch('print-layouts')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Change what is printed on bills and kitchen tickets' })
  @ApiZodBody(UpdateLayoutsDto)
  updateLayouts(@CurrentAuth() auth: AuthContext, @Body() body: UpdateLayoutsDto): Promise<PrintLayoutsDto> {
    return this.printing.updateLayouts(auth, body);
  }

  @Get('print-bridges')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Print bridges and whether each is connected' })
  listBridges(@CurrentAuth() auth: AuthContext): Promise<BridgeDto[]> {
    return this.printing.listBridges(auth);
  }

  @Post('print-bridges')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Add a print bridge. The token in the answer is shown only this once.' })
  @ApiZodBody(CreateBridgeDto)
  createBridge(@CurrentAuth() auth: AuthContext, @Body() body: CreateBridgeDto): Promise<BridgeCreatedDto> {
    return this.printing.createBridge(auth, body);
  }

  @Delete('print-bridges/:id')
  @RequirePermissions('settings.manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a print bridge; its token stops working' })
  deleteBridge(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.printing.deleteBridge(auth, id);
  }

  @Get('print-jobs')
  @ApiOperation({ summary: 'The print queue: your own jobs, or all of them with settings.manage' })
  jobs(@CurrentAuth() auth: AuthContext, @Query() query: PrintJobQueryDto): Promise<Page<PrintJobDto>> {
    return this.queue.list(auth, query);
  }

  @Post('print-jobs/:id/retry')
  @ApiOperation({ summary: 'Send a failed print job again' })
  retry(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<PrintJobDto> {
    return this.queue.retry(auth, id);
  }
}

type BridgeRequest = Request & { bridge?: { id: string; restaurantId: string; lastSeenAt: Date | null } };

/** Admits a print bridge by the token it was given when it was added. A bridge can only take and report print jobs. */
@Injectable()
export class BridgeGuard implements CanActivate {
  constructor(private readonly prisma: PrismaClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<BridgeRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bridge ')) throw new UnauthorizedException('This is for print bridges.');
    const bridge = await this.prisma.printBridge.findUnique({ where: { tokenHash: hashBridgeToken(header.slice(7).trim()) }, include: { restaurant: { select: { isActive: true } } } });
    if (!bridge || !bridge.restaurant.isActive) throw new UnauthorizedException('This print bridge is not known. Add it again under Settings, Printers.');
    req.bridge = { id: bridge.id, restaurantId: bridge.restaurantId, lastSeenAt: bridge.lastSeenAt };
    return true;
  }
}

@ApiTags('print bridge')
@Public()
@UseGuards(BridgeGuard)
@Controller('print-bridge')
export class BridgeController {
  constructor(private readonly queue: PrintQueueService) {}

  @Post('claim')
  @HttpCode(200)
  @ApiOperation({ summary: 'For the print bridge: take the jobs that are waiting' })
  @ApiZodBody(BridgeHelloDto)
  async claim(@Req() req: BridgeRequest, @Body() body: BridgeHelloDto): Promise<{ jobs: BridgeJob[] }> {
    return { jobs: await this.queue.claim(req.bridge!, body.version) };
  }

  @Post('jobs/:id/result')
  @HttpCode(204)
  @ApiOperation({ summary: 'For the print bridge: report whether a job printed' })
  @ApiZodBody(BridgeResultDto)
  result(@Req() req: BridgeRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: BridgeResultDto): Promise<void> {
    return this.queue.report(req.bridge!, id, body);
  }
}

@Module({
  controllers: [PrintingController, BridgeController],
  providers: [PrintingService, PrintQueueService, BridgeGuard],
  exports: [PrintingService, PrintQueueService],
})
export class PrintingModule {}
