export class DeskApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string
  ) {
    super(message);
    this.name = 'DeskApiError';
  }
}

export class ApiValidationError extends DeskApiError {
  constructor(message: string) {
    super(message, 400, 'invalid-input');
    this.name = 'ApiValidationError';
  }
}

export class ApiConflictError extends DeskApiError {
  constructor(message: string) {
    super(message, 409, 'conflict');
    this.name = 'ApiConflictError';
  }
}

export class ApiNotFoundError extends DeskApiError {
  constructor(message: string) {
    super(message, 404, 'not-found');
    this.name = 'ApiNotFoundError';
  }
}

export function readRequiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiValidationError(`${name} must be a non-empty string`);
  }
  return value;
}

export function readStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ApiValidationError(`${name} must be an array of strings`);
  }
  return value as string[];
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function readPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 1000) {
    throw new ApiValidationError(`${name} must be a positive integer`);
  }
  return value;
}

export function readBoundedInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiValidationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
