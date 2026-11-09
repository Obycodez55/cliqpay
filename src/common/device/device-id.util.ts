import { HttpStatus } from '@nestjs/common';
import { Request } from 'express';
import { DomainException } from '../exceptions/domain.exception';

export const DEVICE_ID_HEADER = 'x-device-id';
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export class DeviceIdRequiredException extends DomainException {
  readonly code = 'DEVICE_ID_REQUIRED';
  constructor() {
    super(
      'X-Device-Id header is required (8-128 characters: letters, digits, dot, underscore, hyphen)',
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class DeviceMismatchException extends DomainException {
  readonly code = 'DEVICE_MISMATCH';
  constructor() {
    super(
      'This request does not come from the device it was issued to',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export function readDeviceId(req: Request): string {
  const value = req.headers[DEVICE_ID_HEADER];
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value)) {
    throw new DeviceIdRequiredException();
  }
  return value;
}
