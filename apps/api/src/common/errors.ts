import { HttpStatus } from '@nestjs/common';
import { DomainError } from './filters/api-exception.filter.js';

export const notFound = (what: string) => new DomainError('NOT_FOUND', `${what} not found.`, HttpStatus.NOT_FOUND);
export const conflict = (code: string, message: string) => new DomainError(code, message, HttpStatus.CONFLICT);
export const forbidden = (message: string) => new DomainError('FORBIDDEN', message, HttpStatus.FORBIDDEN);
export const invalid = (code: string, message: string) => new DomainError(code, message, HttpStatus.UNPROCESSABLE_ENTITY);

/** Drops keys whose value is undefined, so a partial update only touches fields that were sent. */
export function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, inner]) => inner !== undefined)) as never;
}
