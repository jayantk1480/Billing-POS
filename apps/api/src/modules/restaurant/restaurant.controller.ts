import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createTerminalSchema, type RestaurantDto, type SettingsDto, type StationDto, stationSchema, type TaxGroupDto,
  taxGroupSchema, type TerminalDto, updateRestaurantSchema, updateSettingsSchema, updateStationSchema,
  updateTaxGroupSchema, updateTerminalSchema,
} from '@pos/validation';
import { type AuthContext, CurrentAuth, RequirePermissions } from '../../common/auth/auth-context.js';
import { ApiZodBody, createZodDto } from '../../common/zod.js';
import { RestaurantService } from './restaurant.service.js';

class UpdateRestaurantDto extends createZodDto(updateRestaurantSchema) {}
class UpdateSettingsDto extends createZodDto(updateSettingsSchema) {}
class TaxGroupDtoIn extends createZodDto(taxGroupSchema) {}
class UpdateTaxGroupDto extends createZodDto(updateTaxGroupSchema) {}
class CreateTerminalDto extends createZodDto(createTerminalSchema) {}
class UpdateTerminalDto extends createZodDto(updateTerminalSchema) {}
class StationDtoIn extends createZodDto(stationSchema) {}
class UpdateStationDto extends createZodDto(updateStationSchema) {}

/** Reading these is open to every signed-in user (the POS needs them); changing them needs settings.manage. */
@ApiTags('settings')
@ApiBearerAuth()
@Controller()
export class RestaurantController {
  constructor(private readonly service: RestaurantService) {}

  @Get('restaurant')
  @ApiOperation({ summary: 'Restaurant profile' })
  getRestaurant(@CurrentAuth() auth: AuthContext): Promise<RestaurantDto> {
    return this.service.getRestaurant(auth);
  }

  @Patch('restaurant')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Update the restaurant profile' })
  @ApiZodBody(UpdateRestaurantDto)
  updateRestaurant(@CurrentAuth() auth: AuthContext, @Body() body: UpdateRestaurantDto): Promise<RestaurantDto> {
    return this.service.updateRestaurant(auth, body);
  }

  @Get('settings')
  @ApiOperation({ summary: 'Billing settings' })
  getSettings(@CurrentAuth() auth: AuthContext): Promise<SettingsDto> {
    return this.service.getSettings(auth);
  }

  @Patch('settings')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Update billing settings' })
  @ApiZodBody(UpdateSettingsDto)
  updateSettings(@CurrentAuth() auth: AuthContext, @Body() body: UpdateSettingsDto): Promise<SettingsDto> {
    return this.service.updateSettings(auth, body);
  }

  @Get('tax-groups')
  @ApiOperation({ summary: 'List tax groups' })
  listTaxGroups(@CurrentAuth() auth: AuthContext): Promise<TaxGroupDto[]> {
    return this.service.listTaxGroups(auth);
  }

  @Post('tax-groups')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Create a tax group' })
  @ApiZodBody(TaxGroupDtoIn)
  createTaxGroup(@CurrentAuth() auth: AuthContext, @Body() body: TaxGroupDtoIn): Promise<TaxGroupDto> {
    return this.service.createTaxGroup(auth, body);
  }

  @Patch('tax-groups/:id')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Update a tax group' })
  @ApiZodBody(UpdateTaxGroupDto)
  updateTaxGroup(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateTaxGroupDto): Promise<TaxGroupDto> {
    return this.service.updateTaxGroup(auth, id, body);
  }

  @Delete('tax-groups/:id')
  @RequirePermissions('settings.manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an unused tax group' })
  deleteTaxGroup(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.service.deleteTaxGroup(auth, id);
  }

  @Get('terminals')
  @ApiOperation({ summary: 'List billing terminals' })
  listTerminals(@CurrentAuth() auth: AuthContext): Promise<TerminalDto[]> {
    return this.service.listTerminals(auth);
  }

  @Post('terminals')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Register a billing terminal' })
  @ApiZodBody(CreateTerminalDto)
  createTerminal(@CurrentAuth() auth: AuthContext, @Body() body: CreateTerminalDto): Promise<TerminalDto> {
    return this.service.createTerminal(auth, body);
  }

  @Patch('terminals/:id')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Rename or deactivate a terminal' })
  @ApiZodBody(UpdateTerminalDto)
  updateTerminal(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateTerminalDto): Promise<TerminalDto> {
    return this.service.updateTerminal(auth, id, body);
  }

  @Get('stations')
  @ApiOperation({ summary: 'List kitchen stations' })
  listStations(@CurrentAuth() auth: AuthContext): Promise<StationDto[]> {
    return this.service.listStations(auth);
  }

  @Post('stations')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Create a kitchen station' })
  @ApiZodBody(StationDtoIn)
  createStation(@CurrentAuth() auth: AuthContext, @Body() body: StationDtoIn): Promise<StationDto> {
    return this.service.createStation(auth, body);
  }

  @Patch('stations/:id')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Update a kitchen station' })
  @ApiZodBody(UpdateStationDto)
  updateStation(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateStationDto): Promise<StationDto> {
    return this.service.updateStation(auth, id, body);
  }

  @Delete('stations/:id')
  @RequirePermissions('settings.manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a kitchen station with no products' })
  deleteStation(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.service.deleteStation(auth, id);
  }
}

@Module({ controllers: [RestaurantController], providers: [RestaurantService], exports: [RestaurantService] })
export class RestaurantModule {}
