import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type AreaDto, areaSchema, createTableSchema, type KotDto, kotQuerySchema, layoutSchema, transferOrderSchema, updateKotStatusSchema, updateTableSchema,
  amendOrderSchema, cancelInvoiceSchema, changePaymentMethodSchema, type InvoiceDto, type InvoiceListItemDto, invoiceQuerySchema, issueInvoicesSchema, mergeOrderSchema,
  type OrderDto, orderQuerySchema, type OrderSummaryDto, type Page, type PosBootstrap, printDocumentQuerySchema, type PrintJobDto, printRequestSchema, reasonSchema, recordPaymentsSchema,
  refundInputSchema, type RenumberResult, saveOrderSchema, type TableDto,
  registerDeviceSchema, type PosDeviceDto,
} from '@pos/validation';
import type { PrintDocument } from '@pos/types';
import type { Response } from 'express';
import { type AuthContext, CurrentAuth, RequirePermissions, RequireAnyPermission } from '../../common/auth/auth-context.js';
import { ApiZodBody, createZodDto } from '../../common/zod.js';
import { MenuModule } from '../menu/menu.controller.js';
import { PrintingModule } from '../printing/printing.controller.js';
import { PrintingService } from '../printing/printing.service.js';
import { MenuService } from '../menu/menu.service.js';
import { RestaurantModule } from '../restaurant/restaurant.controller.js';
import { RestaurantService } from '../restaurant/restaurant.service.js';
import { ApprovalsService } from './approvals.service.js';
import { BillingContextService } from './billing-context.js';
import { DevicesService } from './devices.service.js';
import { renderInvoicePdf } from './invoice-pdf.js';
import { InvoicesService } from './invoices.service.js';
import { KotsService } from './kots.service.js';
import { OrdersService } from './orders.service.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';
import { TablesService } from './tables.service.js';

class SaveOrderDto extends createZodDto(saveOrderSchema) {}
class ReasonDto extends createZodDto(reasonSchema) {}
class AmendOrderDto extends createZodDto(amendOrderSchema) {}
class MergeDto extends createZodDto(mergeOrderSchema) {}
class OrderQueryDto extends createZodDto(orderQuerySchema) {}
class IssueInvoicesDto extends createZodDto(issueInvoicesSchema) {}
class RegisterDeviceDto extends createZodDto(registerDeviceSchema) {}
class InvoiceQueryDto extends createZodDto(invoiceQuerySchema) {}
class RecordPaymentsDto extends createZodDto(recordPaymentsSchema) {}
class RefundDto extends createZodDto(refundInputSchema) {}
class CancelInvoiceDto extends createZodDto(cancelInvoiceSchema) {}
class ChangePaymentMethodDto extends createZodDto(changePaymentMethodSchema) {}
class TransferDto extends createZodDto(transferOrderSchema) {}
class KotQueryDto extends createZodDto(kotQuerySchema) {}
class PrintDocumentQueryDto extends createZodDto(printDocumentQuerySchema) {}
class KotStatusDto extends createZodDto(updateKotStatusSchema) {}
class AreaDtoIn extends createZodDto(areaSchema) {}
class CreateTableDto extends createZodDto(createTableSchema) {}
class UpdateTableDto extends createZodDto(updateTableSchema) {}
class LayoutDto extends createZodDto(layoutSchema) {}
class PrintRequestDto extends createZodDto(printRequestSchema) {}

@ApiTags('pos')
@ApiBearerAuth()
@Controller()
export class PosController {
  constructor(
    private readonly restaurant: RestaurantService,
    private readonly menu: MenuService,
    private readonly tableService: TablesService,
    private readonly context: BillingContextService,
    private readonly printing: PrintingService,
    private readonly devices: DevicesService,
  ) {}

  @Post('pos/devices')
  @RequirePermissions('order.create')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign this device up for billing offline; the same device key always returns the same device' })
  @ApiZodBody(RegisterDeviceDto)
  registerDevice(@CurrentAuth() auth: AuthContext, @Body() body: RegisterDeviceDto): Promise<PosDeviceDto> {
    return this.devices.register(auth, body);
  }

  @Get('pos/bootstrap')
  @RequirePermissions('menu.view')
  @ApiOperation({ summary: 'Everything the POS needs to take orders, in one request' })
  async bootstrap(@CurrentAuth() auth: AuthContext): Promise<PosBootstrap> {
    const [restaurant, settings, terminals, categories, products, modifierGroups, taxGroups, tables, ctx, printLayouts, stations] = await Promise.all([
      this.restaurant.getRestaurant(auth), this.restaurant.getSettings(auth), this.restaurant.listTerminals(auth),
      this.menu.listCategories(auth), this.menu.sellableProducts(auth), this.menu.listModifierGroups(auth),
      this.restaurant.listTaxGroups(auth), this.tableService.list(auth), this.context.load(auth.restaurantId),
      this.printing.layouts(auth.restaurantId), this.restaurant.listStations(auth),
    ]);
    const stationNames = new Map(stations.map((station) => [station.id, station.name]));
    return {
      restaurant, settings, categories: categories.filter((c) => c.isActive), products,
      modifierGroups: modifierGroups.filter((g) => g.isActive), taxGroups, tables,
      terminal: terminals.find((terminal) => terminal.id === auth.terminalId) ?? null,
      businessDate: ctx.businessDate,
      printLayouts,
      stations: ctx.activeStationIds.map((id) => ({ id, name: stationNames.get(id) ?? 'Kitchen' })),
    };
  }

  @Get('tables')
  @ApiOperation({ summary: 'Tables with their position, status and running order' })
  tables(@CurrentAuth() auth: AuthContext): Promise<TableDto[]> {
    return this.tableService.list(auth);
  }
}

@ApiTags('floor')
@ApiBearerAuth()
@Controller()
export class FloorController {
  constructor(private readonly floor: TablesService) {}

  @Get('areas')
  @ApiOperation({ summary: 'Dining areas' })
  areas(@CurrentAuth() auth: AuthContext): Promise<AreaDto[]> {
    return this.floor.listAreas(auth);
  }

  @Post('areas')
  @RequirePermissions('tables.manage')
  @ApiOperation({ summary: 'Add a dining area' })
  @ApiZodBody(AreaDtoIn)
  createArea(@CurrentAuth() auth: AuthContext, @Body() body: AreaDtoIn): Promise<AreaDto> {
    return this.floor.createArea(auth, body);
  }

  @Patch('areas/:id')
  @RequirePermissions('tables.manage')
  @ApiOperation({ summary: 'Rename a dining area' })
  @ApiZodBody(AreaDtoIn)
  updateArea(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: AreaDtoIn): Promise<AreaDto> {
    return this.floor.updateArea(auth, id, body);
  }

  @Delete('areas/:id')
  @RequirePermissions('tables.manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an area that has no tables' })
  deleteArea(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.floor.deleteArea(auth, id);
  }

  @Post('tables')
  @RequirePermissions('tables.manage')
  @ApiOperation({ summary: 'Add a table' })
  @ApiZodBody(CreateTableDto)
  createTable(@CurrentAuth() auth: AuthContext, @Body() body: CreateTableDto): Promise<TableDto> {
    return this.floor.createTable(auth, body);
  }

  @Put('tables/layout')
  @RequirePermissions('tables.manage')
  @ApiOperation({ summary: 'Save table positions from the floor editor' })
  @ApiZodBody(LayoutDto)
  saveLayout(@CurrentAuth() auth: AuthContext, @Body() body: LayoutDto): Promise<TableDto[]> {
    return this.floor.saveLayout(auth, body);
  }

  @Patch('tables/:id')
  @RequirePermissions('tables.manage')
  @ApiOperation({ summary: 'Rename, resize, move to another area, or block a table' })
  @ApiZodBody(UpdateTableDto)
  updateTable(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateTableDto): Promise<TableDto> {
    return this.floor.updateTable(auth, id, body);
  }

  @Delete('tables/:id')
  @RequirePermissions('tables.manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a table that has no running order' })
  deleteTable(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.floor.deleteTable(auth, id);
  }
}

@ApiTags('kitchen')
@ApiBearerAuth()
@Controller('kots')
export class KitchenController {
  constructor(private readonly kots: KotsService) {}

  @Get()
  @ApiOperation({ summary: 'Kitchen tickets, for the kitchen display or one order' })
  list(@CurrentAuth() auth: AuthContext, @Query() query: KotQueryDto): Promise<KotDto[]> {
    return this.kots.list(auth, query);
  }

  @Patch(':id/status')
  @RequirePermissions('kot.update_status')
  @ApiOperation({ summary: 'Move a ticket to preparing, ready or done' })
  @ApiZodBody(KotStatusDto)
  setStatus(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: KotStatusDto): Promise<KotDto> {
    return this.kots.setStatus(auth, id, body.status);
  }

  @Post(':id/printed')
  @RequirePermissions('kot.fire')
  @HttpCode(200)
  @ApiOperation({ summary: 'Record that a ticket was printed; later prints count as reprints' })
  printed(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<KotDto> {
    return this.kots.markPrinted(auth, id);
  }

  @Post(':id/print')
  @RequirePermissions('kot.fire')
  @ApiOperation({ summary: 'Send a ticket to its station printer through the print bridge' })
  @ApiZodBody(PrintRequestDto)
  print(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PrintRequestDto): Promise<PrintJobDto> {
    return this.kots.print(auth, id, body);
  }

  @Get(':id/print-document')
  @RequirePermissions('kot.fire')
  @ApiOperation({ summary: 'The ticket laid out for a printer connected to this device' })
  printDocument(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: PrintDocumentQueryDto): Promise<PrintDocument> {
    return this.kots.printDocument(auth, id, query.width);
  }
}

@ApiTags('orders')
@ApiBearerAuth()
@RequirePermissions('order.create')
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly invoices: InvoicesService,
    private readonly kots: KotsService,
  ) {}

  @Get()
  @RequireAnyPermission('order.create', 'order.view_all')
  @ApiOperation({ summary: 'Order history with filters' })
  list(@CurrentAuth() auth: AuthContext, @Query() query: OrderQueryDto): Promise<Page<OrderSummaryDto>> {
    return this.orders.list(auth, query);
  }

  @Get('running')
  @ApiOperation({ summary: 'Orders in progress: open, held, or billed and unpaid' })
  running(@CurrentAuth() auth: AuthContext): Promise<OrderSummaryDto[]> {
    return this.orders.running(auth);
  }

  @Post('renumber')
  @RequirePermissions('order.renumber')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close gaps in the current order numbers' })
  renumber(@CurrentAuth() auth: AuthContext): Promise<RenumberResult> {
    return this.orders.renumber(auth);
  }

  @Post('restart-numbering')
  @RequirePermissions('order.renumber')
  @HttpCode(204)
  @ApiOperation({ summary: 'Start order numbers again from 1' })
  restartNumbering(@CurrentAuth() auth: AuthContext): Promise<void> {
    return this.orders.restartNumbering(auth);
  }

  @Get(':id')
  @RequireAnyPermission('order.create', 'order.view_all')
  @ApiOperation({ summary: 'One order with its lines' })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<OrderDto> {
    return this.orders.get(auth, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Create an order, or replace its details and lines' })
  @ApiZodBody(SaveOrderDto)
  save(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaveOrderDto): Promise<OrderDto> {
    return this.orders.save(auth, id, body);
  }

  @Post(':id/hold')
  @HttpCode(200)
  @ApiOperation({ summary: 'Park an order to continue later' })
  hold(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<OrderDto> {
    return this.orders.hold(auth, id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @ApiOperation({ summary: 'Bring a held order back into editing' })
  resume(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<OrderDto> {
    return this.orders.resume(auth, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel an unbilled order (needs order.cancel or a manager PIN)' })
  @ApiZodBody(ReasonDto)
  cancel(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto): Promise<OrderDto> {
    return this.orders.cancel(auth, id, body);
  }

  @Post(':id/delete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete an order and renumber later ones. A billed order takes its bills and payments with it and needs invoice.delete.' })
  @ApiZodBody(ReasonDto)
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto): Promise<RenumberResult> {
    return this.orders.remove(auth, id, body);
  }

  @Post(':id/amend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change the items of a billed order and issue its bill again under the same number (needs invoice.delete)' })
  @ApiZodBody(AmendOrderDto)
  amend(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: AmendOrderDto): Promise<OrderDto> {
    return this.invoices.amend(auth, id, body);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @ApiOperation({ summary: 'Put a billed or settled order back into editing, erasing its bills and payments (needs invoice.delete)' })
  @ApiZodBody(ReasonDto)
  reopen(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto): Promise<OrderDto> {
    return this.orders.reopen(auth, id, body);
  }

  @Post(':id/merge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Merge another unbilled order into this one' })
  @ApiZodBody(MergeDto)
  merge(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: MergeDto): Promise<OrderDto> {
    return this.orders.merge(auth, id, body);
  }

  @Post(':id/transfer')
  @RequirePermissions('order.transfer')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move a running dine-in order to another free table' })
  @ApiZodBody(TransferDto)
  transfer(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: TransferDto): Promise<OrderDto> {
    return this.orders.transfer(auth, id, body.tableId);
  }

  @Post(':id/kots')
  @RequirePermissions('kot.fire')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send everything not yet sent to the kitchen: one ticket per station' })
  fire(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<KotDto[]> {
    return this.kots.fire(auth, id);
  }

  @Post(':id/invoices')
  @RequirePermissions('invoice.create')
  @ApiOperation({ summary: 'Bill the order: one invoice, or several when split by item' })
  @ApiZodBody(IssueInvoicesDto)
  issue(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: IssueInvoicesDto): Promise<InvoiceDto[]> {
    return this.invoices.issue(auth, id, body);
  }
}

@ApiTags('invoices')
@ApiBearerAuth()
@RequirePermissions('invoice.create')
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @RequireAnyPermission('invoice.create', 'order.view_all')
  @ApiOperation({ summary: 'Bills with filters' })
  list(@CurrentAuth() auth: AuthContext, @Query() query: InvoiceQueryDto): Promise<Page<InvoiceListItemDto>> {
    return this.invoices.list(auth, query);
  }

  @Get(':id')
  @RequireAnyPermission('invoice.create', 'order.view_all')
  @ApiOperation({ summary: 'One bill with items, taxes, payments and refunds' })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<InvoiceDto> {
    return this.invoices.get(auth, id);
  }

  @Get(':id/pdf')
  @RequireAnyPermission('invoice.create', 'order.view_all')
  @ApiOperation({ summary: 'The bill as an A4 PDF' })
  async pdf(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const invoice = await this.invoices.get(auth, id);
    const pdf = await renderInvoicePdf(invoice);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.length),
      'Content-Disposition': `inline; filename="${invoice.invoiceNumber.replaceAll('/', '-')}.pdf"`,
      'Cache-Control': 'private, no-store',
    });
    res.end(pdf);
  }

  @Post(':id/printed')
  @HttpCode(200)
  @ApiOperation({ summary: 'Record that the bill was printed; later prints count as reprints' })
  printed(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<InvoiceDto> {
    return this.invoices.markPrinted(auth, id);
  }

  @Post(':id/print')
  @ApiOperation({ summary: 'Send the bill to the receipt printer through the print bridge' })
  @ApiZodBody(PrintRequestDto)
  print(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PrintRequestDto): Promise<PrintJobDto> {
    return this.invoices.print(auth, id, body);
  }

  @Get(':id/print-document')
  @ApiOperation({ summary: 'The bill laid out for a printer connected to this device' })
  printDocument(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: PrintDocumentQueryDto): Promise<PrintDocument> {
    return this.invoices.printDocument(auth, id, query.width);
  }

  @Post(':id/refunds/:refundId/print')
  @ApiOperation({ summary: 'Send the credit note of a refund to the receipt printer' })
  @ApiZodBody(PrintRequestDto)
  printCreditNote(
    @CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('refundId', ParseUUIDPipe) refundId: string, @Body() body: PrintRequestDto,
  ): Promise<PrintJobDto> {
    return this.invoices.printCreditNote(auth, id, refundId, body);
  }

  @Post(':id/payments')
  @RequirePermissions('payment.record')
  @HttpCode(200)
  @ApiOperation({ summary: 'Record one or more tenders against the bill' })
  @ApiZodBody(RecordPaymentsDto)
  pay(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RecordPaymentsDto): Promise<InvoiceDto> {
    return this.invoices.recordPayments(auth, id, body);
  }

  @Patch(':id/payments/:paymentId')
  @RequirePermissions('payment.change_method')
  @ApiOperation({ summary: 'Correct the method of a payment already recorded' })
  @ApiZodBody(ChangePaymentMethodDto)
  changePaymentMethod(
    @CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() body: ChangePaymentMethodDto,
  ): Promise<InvoiceDto> {
    return this.invoices.changePaymentMethod(auth, id, paymentId, body);
  }

  @Post(':id/refunds')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refund a payment and issue a credit note (needs refund.create or a manager PIN)' })
  @ApiZodBody(RefundDto)
  refund(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RefundDto): Promise<InvoiceDto> {
    return this.invoices.refund(auth, id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a bill that has no money against it (needs permission or a manager PIN)' })
  @ApiZodBody(CancelInvoiceDto)
  cancel(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: CancelInvoiceDto): Promise<InvoiceDto> {
    return this.invoices.cancel(auth, id, body);
  }
}

@Module({
  imports: [RestaurantModule, MenuModule, PrintingModule],
  controllers: [PosController, FloorController, KitchenController, OrdersController, InvoicesController, SyncController],
  providers: [BillingContextService, ApprovalsService, KotsService, TablesService, OrdersService, InvoicesService, DevicesService, SyncService],
  exports: [BillingContextService, ApprovalsService, InvoicesService, KotsService],
})
export class BillingModule {}
