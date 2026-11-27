import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createRoleSchema, createUserSchema, type PermissionDto, type RoleDto, updateRoleSchema, updateUserSchema, type UserDto,
} from '@pos/validation';
import { type AuthContext, CurrentAuth, RequirePermissions } from '../../common/auth/auth-context.js';
import { ApiZodBody, createZodDto } from '../../common/zod.js';
import { UsersService } from './users.service.js';

class CreateUserDto extends createZodDto(createUserSchema) {}
class UpdateUserDto extends createZodDto(updateUserSchema) {}
class CreateRoleDto extends createZodDto(createRoleSchema) {}
class UpdateRoleDto extends createZodDto(updateRoleSchema) {}

@ApiTags('users')
@ApiBearerAuth()
@RequirePermissions('users.manage')
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  @ApiOperation({ summary: 'List users' })
  listUsers(@CurrentAuth() auth: AuthContext): Promise<UserDto[]> {
    return this.users.listUsers(auth);
  }

  @Post('users')
  @ApiOperation({ summary: 'Create a user' })
  @ApiZodBody(CreateUserDto)
  createUser(@CurrentAuth() auth: AuthContext, @Body() body: CreateUserDto): Promise<UserDto> {
    return this.users.createUser(auth, body);
  }

  @Patch('users/:id')
  @ApiOperation({ summary: 'Update a user, including role, status, password and PIN' })
  @ApiZodBody(UpdateUserDto)
  updateUser(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateUserDto): Promise<UserDto> {
    return this.users.updateUser(auth, id, body);
  }

  @Get('permissions')
  @ApiOperation({ summary: 'List every permission a role can hold' })
  listPermissions(): PermissionDto[] {
    return this.users.listPermissions();
  }

  @Get('roles')
  @ApiOperation({ summary: 'List roles with their permissions' })
  listRoles(@CurrentAuth() auth: AuthContext): Promise<RoleDto[]> {
    return this.users.listRoles(auth);
  }

  @Post('roles')
  @ApiOperation({ summary: 'Create a role' })
  @ApiZodBody(CreateRoleDto)
  createRole(@CurrentAuth() auth: AuthContext, @Body() body: CreateRoleDto): Promise<RoleDto> {
    return this.users.createRole(auth, body);
  }

  @Patch('roles/:id')
  @ApiOperation({ summary: 'Rename a role or change its permissions' })
  @ApiZodBody(UpdateRoleDto)
  updateRole(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateRoleDto): Promise<RoleDto> {
    return this.users.updateRole(auth, id, body);
  }

  @Delete('roles/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a custom role that has no users' })
  deleteRole(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.users.deleteRole(auth, id);
  }
}
