import {
  Body, type CallHandler, Controller, Delete, type ExecutionContext, Get, HttpCode, Injectable, Module, type NestInterceptor, Param, ParseUUIDPipe, Patch,
  Post, Put, Query, UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  availabilitySchema, bulkDeleteProductsSchema, bulkProductsSchema, type BulkProductsResult, type CategoryDto, categorySchema, createProductSchema,
  type ModifierGroupDto, modifierGroupSchema, type Page, type ProductDto, productQuerySchema, reorderSchema, updateCategorySchema, updateProductSchema,
} from '@pos/validation';
import { REALTIME_EVENTS } from '@pos/types';
import { type Observable, tap } from 'rxjs';
import { type AuthContext, type AuthedRequest, CurrentAuth, RequirePermissions } from '../../common/auth/auth-context.js';
import { ApiZodBody, createZodDto } from '../../common/zod.js';
import { RealtimeService } from '../realtime/realtime.gateway.js';
import { MenuService } from './menu.service.js';

class CategoryDtoIn extends createZodDto(categorySchema) {}
class UpdateCategoryDto extends createZodDto(updateCategorySchema) {}
class ReorderDto extends createZodDto(reorderSchema) {}
class ModifierGroupDtoIn extends createZodDto(modifierGroupSchema) {}
class CreateProductDto extends createZodDto(createProductSchema) {}
class UpdateProductDto extends createZodDto(updateProductSchema) {}
class ProductQueryDto extends createZodDto(productQuerySchema) {}
class AvailabilityDto extends createZodDto(availabilitySchema) {}
class BulkProductsDto extends createZodDto(bulkProductsSchema) {}
class BulkDeleteProductsDto extends createZodDto(bulkDeleteProductsSchema) {}

/** After any successful change to the menu, tells billing screens to reload it. */
@Injectable()
class MenuChangedInterceptor implements NestInterceptor {
  constructor(private readonly realtime: RealtimeService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    // A dry run of an import changes nothing, so there is nothing to reload.
    if (request.method === 'GET' || !request.auth || (request.body as { dryRun?: unknown } | undefined)?.dryRun === true) return next.handle();
    const { restaurantId } = request.auth;
    return next.handle().pipe(tap(() => this.realtime.emit(restaurantId, REALTIME_EVENTS.menuUpdated)));
  }
}

@ApiTags('menu')
@ApiBearerAuth()
@RequirePermissions('menu.view')
@UseInterceptors(MenuChangedInterceptor)
@Controller()
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Get('categories')
  @ApiOperation({ summary: 'List categories in display order' })
  listCategories(@CurrentAuth() auth: AuthContext): Promise<CategoryDto[]> {
    return this.menu.listCategories(auth);
  }

  @Post('categories')
  @RequirePermissions('menu.manage')
  @ApiOperation({ summary: 'Create a category' })
  @ApiZodBody(CategoryDtoIn)
  createCategory(@CurrentAuth() auth: AuthContext, @Body() body: CategoryDtoIn): Promise<CategoryDto> {
    return this.menu.createCategory(auth, body);
  }

  @Put('categories/order')
  @RequirePermissions('menu.manage')
  @ApiOperation({ summary: 'Set the display order of all categories' })
  @ApiZodBody(ReorderDto)
  reorderCategories(@CurrentAuth() auth: AuthContext, @Body() body: ReorderDto): Promise<CategoryDto[]> {
    return this.menu.reorderCategories(auth, body.ids);
  }

  @Patch('categories/:id')
  @RequirePermissions('menu.manage')
  @ApiOperation({ summary: 'Update a category' })
  @ApiZodBody(UpdateCategoryDto)
  updateCategory(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateCategoryDto): Promise<CategoryDto> {
    return this.menu.updateCategory(auth, id, body);
  }

  @Delete('categories/:id')
  @RequirePermissions('menu.manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an empty category' })
  deleteCategory(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.menu.deleteCategory(auth, id);
  }

  @Get('modifier-groups')
  @ApiOperation({ summary: 'List modifier groups with their options' })
  listModifierGroups(@CurrentAuth() auth: AuthContext): Promise<ModifierGroupDto[]> {
    return this.menu.listModifierGroups(auth);
  }

  @Post('modifier-groups')
  @RequirePermissions('menu.manage')
  @ApiOperation({ summary: 'Create a modifier group' })
  @ApiZodBody(ModifierGroupDtoIn)
  createModifierGroup(@CurrentAuth() auth: AuthContext, @Body() body: ModifierGroupDtoIn): Promise<ModifierGroupDto> {
    return this.menu.createModifierGroup(auth, body);
  }

  @Put('modifier-groups/:id')
  @RequirePermissions('menu.manage')
  @ApiOperation({ summary: 'Replace a modifier group and its options' })
  @ApiZodBody(ModifierGroupDtoIn)
  updateModifierGroup(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ModifierGroupDtoIn): Promise<ModifierGroupDto> {
    return this.menu.updateModifierGroup(auth, id, body);
  }

  @Delete('modifier-groups/:id')
  @RequirePermissions('menu.manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a modifier group and detach it from products' })
  deleteModifierGroup(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.menu.deleteModifierGroup(auth, id);
  }

  @Get('products')
  @ApiOperation({ summary: 'Search and page through products' })
  listProducts(@CurrentAuth() auth: AuthContext, @Query() query: ProductQueryDto): Promise<Page<ProductDto>> {
    return this.menu.listProducts(auth, query);
  }

  @Get('products/:id')
  @ApiOperation({ summary: 'Get one product' })
  getProduct(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<ProductDto> {
    return this.menu.getProduct(auth, id);
  }

  @Post('products')
  @RequirePermissions('menu.manage')
  @ApiOperation({ summary: 'Create a product with its variants and modifier groups' })
  @ApiZodBody(CreateProductDto)
  createProduct(@CurrentAuth() auth: AuthContext, @Body() body: CreateProductDto): Promise<ProductDto> {
    return this.menu.createProduct(auth, body);
  }

  @Post('products/bulk')
  @RequirePermissions('menu.manage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add many products from spreadsheet rows, skipping rows with mistakes and products already on the menu' })
  @ApiZodBody(BulkProductsDto)
  createProducts(@CurrentAuth() auth: AuthContext, @Body() body: BulkProductsDto): Promise<BulkProductsResult> {
    return this.menu.createProducts(auth, body);
  }

  @Post('products/bulk-delete')
  @RequirePermissions('menu.manage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete many products at once' })
  @ApiZodBody(BulkDeleteProductsDto)
  deleteProducts(@CurrentAuth() auth: AuthContext, @Body() body: BulkDeleteProductsDto): Promise<{ deleted: number }> {
    return this.menu.deleteProducts(auth, body.ids);
  }

  @Patch('products/:id')
  @RequirePermissions('menu.manage')
  @ApiOperation({ summary: 'Update a product' })
  @ApiZodBody(UpdateProductDto)
  updateProduct(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateProductDto): Promise<ProductDto> {
    return this.menu.updateProduct(auth, id, body);
  }

  @Patch('products/:id/availability')
  @RequirePermissions('menu.availability')
  @ApiOperation({ summary: 'Switch a product on or off' })
  @ApiZodBody(AvailabilityDto)
  setAvailability(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: AvailabilityDto): Promise<ProductDto> {
    return this.menu.setAvailability(auth, id, body.isAvailable);
  }

  @Delete('products/:id')
  @RequirePermissions('menu.manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a product' })
  deleteProduct(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.menu.deleteProduct(auth, id);
  }
}

@Module({ controllers: [MenuController], providers: [MenuService, MenuChangedInterceptor], exports: [MenuService] })
export class MenuModule {}
