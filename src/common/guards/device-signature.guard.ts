import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiHeader, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { readDeviceId } from '../device/device-id.util';
import {
  SIGNATURE_HEADER,
  SIGNATURE_TIMESTAMP_HEADER,
  SIGNED_ACTION_VERIFIER,
  SignedActionResolver,
  SignedActionVerifier,
} from '../device/signed-action';
import { AuthenticatedRequest } from './jwt-auth.guard';

const SIGNED_ACTION_KEY = 'signedAction';

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

// Runs after JwtAuthGuard (class-level guards come first), so req.user is set.
// Reads the raw body: it runs before validation, so a malformed field simply
// fails the signature or is rejected by validation afterwards — nothing has
// been posted either way.
@Injectable()
export class DeviceSignatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(SIGNED_ACTION_VERIFIER)
    private readonly verifier: SignedActionVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const resolve = this.reflector.get<SignedActionResolver>(
      SIGNED_ACTION_KEY,
      context.getHandler(),
    );
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const signed = resolve(request);
    if (!signed) {
      return true;
    }
    await this.verifier.verifySignedAction({
      ...signed,
      userId: request.user.userId,
      deviceId: readDeviceId(request),
      timestamp: header(request, SIGNATURE_TIMESTAMP_HEADER),
      signature: header(request, SIGNATURE_HEADER),
    });
    return true;
  }
}

/**
 * Requires the caller's device to sign this action. `resolve` returns the
 * signed fields from the request, or null when this particular call needs no
 * signature. `signs` is the OpenAPI description of those fields.
 */
export function RequireDeviceSignature(options: {
  action: string;
  signs: string;
  resolve: SignedActionResolver;
}): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(SIGNED_ACTION_KEY, options.resolve),
    UseGuards(DeviceSignatureGuard),
    ApiHeader({
      name: 'X-Device-Signature',
      required: false,
      description:
        'Base64 ASN.1 DER ECDSA P-256 / SHA-256 signature by the device key over the UTF-8 string ' +
        '"action\\nreference\\namount\\ntarget\\ntimestamp" (parts joined by LF 0x0A). ' +
        `Here action is "${options.action}"; ${options.signs}. Required while DEVICE_KEY_REQUIRED is on.`,
    }),
    ApiHeader({
      name: 'X-Signature-Timestamp',
      required: false,
      description:
        'Unix seconds, the same value that was signed; accepted within 2 minutes of server time.',
    }),
    ApiUnauthorizedResponse({
      description:
        'ACTION_SIGNATURE_REQUIRED, ACTION_SIGNATURE_STALE, ACTION_SIGNATURE_INVALID or DEVICE_KEY_NOT_REGISTERED; nothing was changed.',
    }),
  );
}
