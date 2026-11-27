import { randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { invalid } from '../../common/errors.js';
import { env, REPO_ROOT } from '../../config/env.js';

type ImageType = { extension: 'png' | 'jpg' | 'webp'; mime: string };

/** Identifies an image by its leading bytes; the file name and declared type are not trusted. */
function sniffImage(data: Buffer): ImageType | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: 'png', mime: 'image/png' };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { extension: 'jpg', mime: 'image/jpeg' };
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    return { extension: 'webp', mime: 'image/webp' };
  }
  return null;
}

const MIME_BY_EXTENSION: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
export const IMAGE_KEY_PATTERN = /^images\/[0-9a-f-]{36}\.(png|jpg|webp)$/;

/** Stores uploaded images on local disk. An S3 driver with the same methods is added for production. */
@Injectable()
export class StorageService {
  private readonly root = path.resolve(REPO_ROOT, env.STORAGE_LOCAL_DIR);

  async saveImage(data: Buffer): Promise<{ key: string; url: string }> {
    const type = sniffImage(data);
    if (!type) throw invalid('UNSUPPORTED_IMAGE', 'Upload a PNG, JPEG or WebP image.');
    const key = `images/${randomUUID()}.${type.extension}`;
    const target = path.join(this.root, key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx' });
    return { key, url: this.publicUrl(key) };
  }

  publicUrl(key: string): string;
  publicUrl(key: string | null): string | null;
  publicUrl(key: string | null): string | null {
    return key ? `${env.API_PUBLIC_URL}/api/v1/files/${key}` : null;
  }

  /** Opens a stored image, or returns null if the key is malformed or the file is missing. */
  async open(key: string): Promise<{ stream: ReadStream; mime: string; size: number } | null> {
    if (!IMAGE_KEY_PATTERN.test(key)) return null;
    const target = path.join(this.root, key);
    try {
      const info = await stat(target);
      return { stream: createReadStream(target), mime: MIME_BY_EXTENSION[key.split('.').pop()!]!, size: info.size };
    } catch {
      return null;
    }
  }
}
