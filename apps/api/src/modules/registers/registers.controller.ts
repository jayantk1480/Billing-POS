import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  cashMovementSchema, closeRegisterSchema, isoDateSchema, openRegisterSchema, type Page, type PaymentListItemDto, paymentMethodSchema, paymentQuerySchema, printDocumentQuerySchema, type PrintJobDto, printRequestSchema,
  type ReconciliationDto, reconciliationQuerySchema, type ReconciliationRowDto, type RegisterDetailDto, registerQuerySchema, type RegisterSessionDto, saveReconciliationSchema,
} from '@pos/validation';
import type { PrintDocument } from '@pos/types';
import { type AuthContext, CurrentAuth, RequireAnyPermission, RequirePermissions } from '../../common/auth/auth-context.js';
import { invalid } from '../../common/errors.js';
import { ApiZodBody, createZodDto } from '../../common/zod.js';
import { BillingModule } from '../billing/billing.controller.js';
import { PrintingModule } from '../printing/printing.controller.js';
import { ReconciliationService } from './reconciliation.service.js';
import { RegistersService } from './registers.service.js';

class OpenRegisterDto extends createZodDto(openRegisterSchema) {}
class CashMovementDto extends createZodDto(cashMovementSchema) {}
class CloseRegisterDto extends createZodDto(closeRegisterSchema) {}
class RegisterQueryDto extends createZodDto(registerQuerySchema) {}
class ReconciliationQueryDto extends createZodDto(reconciliationQuerySchema) {}
class SaveReconciliationDto extends createZodDto(saveReconciliationSchema) {}
class PaymentQueryDto extends createZodDto(paymentQuerySchema) {}
class PrintRequestDto extends createZodDto(printRequestSchema) {}
class PrintDocumentQueryDto extends createZodDto(printDocumentQuerySchema) {}

@ApiTags('cash register')
@ApiBearerAuth()
@RequirePermissions('register.operate')
@Controller('registers')
export class RegistersController {
  constructor(private readonly registers: RegistersService) {}

  @Get()
  @RequireAnyPermission('register.operate', 'register.view_all')
  @ApiOperation({ summary: 'Cash register sessions: your own, or everyone\'s with register.view_all' })
  list(@CurrentAuth() auth: AuthContext, @Query() query: RegisterQueryDto): Promise<Page<RegisterSessionDto>> {
    return this.registers.list(auth, query);
  }

  @Get('current')
  @ApiOperation({ summary: 'The cash register you have open, if any' })
  async current(@CurrentAuth() auth: AuthContext): Promise<{ register: RegisterDetailDto | null }> {
    return { register: await this.registers.current(auth) };
  }

  @Post('open')
  @ApiOperation({ summary: 'Open a cash register with the cash that is in the drawer' })
  @ApiZodBody(OpenRegisterDto)
  open(@CurrentAuth() auth: AuthContext, @Body() body: OpenRegisterDto): Promise<RegisterDetailDto> {
    return this.registers.open(auth, body);
  }

  @Post('current/movements')
  @ApiOperation({ summary: 'Put cash in or take cash out, with a reason (needs register.adjust or a manager PIN)' })
  @ApiZodBody(CashMovementDto)
  move(@CurrentAuth() auth: AuthContext, @Body() body: CashMovementDto): Promise<RegisterDetailDto> {
    return this.registers.move(auth, body);
  }

  @Get(':id')
  @RequireAnyPermission('register.operate', 'register.view_all')
  @ApiOperation({ summary: 'One cash register session with its takings and cash movements' })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<RegisterDetailDto> {
    return this.registers.get(auth, id);
  }

  @Post(':id/close')
  @RequireAnyPermission('register.operate', 'register.view_all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close a cash register against the cash counted in the drawer' })
  @ApiZodBody(CloseRegisterDto)
  close(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: CloseRegisterDto): Promise<RegisterDetailDto> {
    return this.registers.close(auth, id, body);
  }

  @Post(':id/print')
  @RequireAnyPermission('register.operate', 'register.view_all')
  @ApiOperation({ summary: 'Send the register report to the receipt printer through the print bridge' })
  @ApiZodBody(PrintRequestDto)
  print(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PrintRequestDto): Promise<PrintJobDto> {
    return this.registers.print(auth, id, body);
  }

  @Get(':id/print-document')
  @RequireAnyPermission('register.operate', 'register.view_all')
  @ApiOperation({ summary: 'The register report laid out for a printer connected to this device' })
  printDocument(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: PrintDocumentQueryDto): Promise<PrintDocument> {
    return this.registers.printDocument(auth, id, query.width);
  }
}

@ApiTags('reconciliation')
@ApiBearerAuth()
@RequirePermissions('payment.reconcile')
@Controller()
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get('reconciliation')
  @ApiOperation({ summary: 'Received, refunded and settled amounts per day and payment method' })
  summary(@CurrentAuth() auth: AuthContext, @Query() query: ReconciliationQueryDto): Promise<ReconciliationDto> {
    return this.reconciliation.summary(auth, query);
  }

  @Put('reconciliation')
  @ApiOperation({ summary: 'Enter what actually arrived for one day and payment method' })
  @ApiZodBody(SaveReconciliationDto)
  save(@CurrentAuth() auth: AuthContext, @Body() body: SaveReconciliationDto): Promise<ReconciliationRowDto> {
    return this.reconciliation.save(auth, body);
  }

  @Delete('reconciliation/:date/:method')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove the settled amount entered for one day and payment method' })
  clear(@CurrentAuth() auth: AuthContext, @Param('date') date: string, @Param('method') method: string): Promise<void> {
    const parsedDate = isoDateSchema.safeParse(date);
    const parsedMethod = paymentMethodSchema.safeParse(method);
    if (!parsedDate.success || !parsedMethod.success) throw invalid('VALIDATION_ERROR', 'That day or payment method is not valid.');
    return this.reconciliation.clear(auth, parsedDate.data, parsedMethod.data);
  }

  @Get('payments')
  @RequireAnyPermission('payment.reconcile', 'register.view_all')
  @ApiOperation({ summary: 'Payments received in a period, optionally for one method or one cash register' })
  payments(@CurrentAuth() auth: AuthContext, @Query() query: PaymentQueryDto): Promise<Page<PaymentListItemDto>> {
    return this.reconciliation.payments(auth, query);
  }
}

@Module({
  imports: [BillingModule, PrintingModule],
  controllers: [RegistersController, ReconciliationController],
  providers: [RegistersService, ReconciliationService],
  exports: [RegistersService],
})
export class RegistersModule {}
