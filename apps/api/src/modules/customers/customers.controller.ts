import { Controller, Get, Module, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type CustomerRecordDto, type CustomerListItemDto, type CustomerLookupDto, customerLookupSchema, customerQuerySchema, customerSuggestSchema, type CustomerSuggestionDto, type Page,
} from '@pos/validation';
import { type AuthContext, CurrentAuth, RequireAnyPermission, RequirePermissions } from '../../common/auth/auth-context.js';
import { createZodDto } from '../../common/zod.js';
import { CustomersService } from './customers.service.js';

class CustomerQueryDto extends createZodDto(customerQuerySchema) {}
class CustomerLookupQueryDto extends createZodDto(customerLookupSchema) {}
class CustomerSuggestQueryDto extends createZodDto(customerSuggestSchema) {}

@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermissions('order.view_all')
  @ApiOperation({ summary: 'Customers named on orders, with how often they ordered and what they spent' })
  list(@CurrentAuth() auth: AuthContext, @Query() query: CustomerQueryDto): Promise<Page<CustomerListItemDto>> {
    return this.customers.list(auth, query);
  }

  // Before ":id", or "lookup" would be read as an id.
  @Get('lookup')
  @RequireAnyPermission('order.create', 'order.view_all')
  @ApiOperation({ summary: 'The customer a phone number belongs to, for the billing screen' })
  lookup(@CurrentAuth() auth: AuthContext, @Query() query: CustomerLookupQueryDto): Promise<CustomerLookupDto> {
    return this.customers.lookup(auth, query.phone);
  }

  @Get('suggest')
  @RequireAnyPermission('order.create', 'order.view_all')
  @ApiOperation({ summary: 'Customers whose number begins with the digits typed so far' })
  suggest(@CurrentAuth() auth: AuthContext, @Query() query: CustomerSuggestQueryDto): Promise<CustomerSuggestionDto[]> {
    return this.customers.suggest(auth, query.phone);
  }

  @Get(':id')
  @RequirePermissions('order.view_all')
  @ApiOperation({ summary: 'One customer with every order taken for them' })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<CustomerRecordDto> {
    return this.customers.get(auth, id);
  }
}

@Module({ controllers: [CustomersController], providers: [CustomersService] })
export class CustomersModule {}
