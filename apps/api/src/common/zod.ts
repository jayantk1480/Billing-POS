import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { z } from 'zod';

/** A class Nest can use as a parameter type, carrying the Zod schema that validates it. */
export interface ZodDtoClass<T extends z.ZodType = z.ZodType> {
  new (): z.output<T>;
  schema: T;
}

/** Wraps a shared Zod schema so it can type a controller's `@Body()` or `@Query()` parameter. */
export function createZodDto<T extends z.ZodType>(schema: T): ZodDtoClass<T> {
  class ZodDto {
    static readonly schema = schema;
  }
  return ZodDto as unknown as ZodDtoClass<T>;
}

/** Validates every parameter whose type was made with `createZodDto`. Failures become 400 responses. */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = (metadata.metatype as Partial<ZodDtoClass> | undefined)?.schema;
    return schema ? schema.parse(value) : value;
  }
}

/** Documents a request body in Swagger from its Zod schema. */
export function ApiZodBody(dto: ZodDtoClass): MethodDecorator {
  const schema = z.toJSONSchema(dto.schema, { target: 'openapi-3.0', io: 'input', unrepresentable: 'any' });
  return ApiBody({ schema: schema as Record<string, unknown> });
}
