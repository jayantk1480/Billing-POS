import {
  Controller, Get, Global, Module, Param, Post, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UploadedImage } from '@pos/validation';
import type { Response } from 'express';
import { Public, RequirePermissions } from '../../common/auth/auth-context.js';
import { invalid, notFound } from '../../common/errors.js';
import { StorageService } from './storage.service.js';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly storage: StorageService) {}

  @Post('images')
  @ApiBearerAuth()
  @RequirePermissions('menu.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a product image (PNG, JPEG or WebP, up to 2 MB)' })
  upload(@UploadedFile() file: { buffer: Buffer } | undefined): Promise<UploadedImage> {
    if (!file) throw invalid('FILE_MISSING', 'Choose an image to upload.');
    return this.storage.saveImage(file.buffer);
  }

  /** Images are public: names are unguessable and they appear on customer-facing screens. */
  @Public()
  @Get('images/:name')
  @ApiOperation({ summary: 'Fetch an uploaded image' })
  async image(@Param('name') name: string, @Res() res: Response): Promise<void> {
    const file = await this.storage.open(`images/${name}`);
    if (!file) throw notFound('Image');
    res.set({
      'Content-Type': file.mime,
      'Content-Length': String(file.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
      // The front ends run on other origins, so the image must be embeddable cross-origin.
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    file.stream.pipe(res);
  }
}

@Global()
@Module({ controllers: [FilesController], providers: [StorageService], exports: [StorageService] })
export class FilesModule {}
