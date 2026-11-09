import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import {
  buildSigningString,
  InvalidDevicePublicKeyError,
  normalizeDevicePublicKey,
  verifyDeviceSignature,
} from '../../shared/crypto/device-signature.util';
import {
  DEVICE_ATTESTATION_VERIFIER,
  DeviceAttestationVerifier,
} from './attestation/device-attestation-verifier';
import { DeviceAttestationDto } from './dto/device-attestation.dto';
import {
  DeviceChallenge,
  DeviceChallengePurpose,
} from './entities/device-challenge.entity';
import { AttestationResult } from './entities/trusted-device.entity';
import {
  DeviceAttestationFailedException,
  DeviceChallengeInvalidException,
  DevicePublicKeyInvalidException,
  DevicePublicKeyRequiredException,
  DeviceSignatureRequiredException,
} from './internal/errors';
import { generateOpaqueToken, hashOpaqueToken } from './internal/secrets.util';

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const P256_RAW_LENGTH = 65;

export interface RegisteredDevice {
  publicKey: string | null;
  attestationResult: AttestationResult;
}

// Internal to the auth module. Issues and consumes single-use challenges,
// checks signed challenges, and registers the device key with its
// attestation result.
@Injectable()
export class DeviceBindingService {
  constructor(
    @InjectRepository(DeviceChallenge)
    private readonly challengeRepo: Repository<DeviceChallenge>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DEVICE_ATTESTATION_VERIFIER)
    private readonly attestationVerifier: DeviceAttestationVerifier,
  ) {}

  get keyRequired(): boolean {
    return this.config.device.keyRequired;
  }

  async issueChallenge(
    deviceId: string,
    purpose: DeviceChallengePurpose,
  ): Promise<{ nonce: string; expiresAt: Date }> {
    const nonce = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    await this.challengeRepo.save(
      this.challengeRepo.create({
        nonceHash: hashOpaqueToken(nonce),
        deviceId,
        purpose,
        expiresAt,
        usedAt: null,
      }),
    );
    return { nonce, expiresAt };
  }

  private async consumeChallenge(
    deviceId: string,
    purpose: DeviceChallengePurpose,
    nonce: string,
  ): Promise<void> {
    const result = await this.challengeRepo.update(
      {
        nonceHash: hashOpaqueToken(nonce),
        deviceId,
        purpose,
        usedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
      { usedAt: new Date() },
    );
    if (result.affected !== 1) {
      throw new DeviceChallengeInvalidException();
    }
  }

  /**
   * Consumes the nonce, then checks the signature over
   * `purpose ‖ nonce ‖ deviceId`. A missing, unknown, expired or reused
   * nonce throws; a signature that does not verify returns false so the
   * caller can treat it as a theft signal.
   */
  async verifySignedChallenge(input: {
    purpose: 'login' | 'refresh';
    deviceId: string;
    publicKey: string;
    nonce: string | undefined;
    signature: string | undefined;
  }): Promise<boolean> {
    if (!input.nonce || !input.signature) {
      throw new DeviceSignatureRequiredException();
    }
    await this.consumeChallenge(input.deviceId, input.purpose, input.nonce);
    return verifyDeviceSignature(
      input.publicKey,
      buildSigningString([input.purpose, input.nonce, input.deviceId]),
      input.signature,
    );
  }

  // Validates the submitted key before the MFA code is spent.
  normalizePublicKey(devicePublicKey: string | undefined): string | null {
    if (!devicePublicKey) {
      if (this.keyRequired) {
        throw new DevicePublicKeyRequiredException();
      }
      return null;
    }
    try {
      return normalizeDevicePublicKey(devicePublicKey);
    } catch (error) {
      if (error instanceof InvalidDevicePublicKeyError) {
        throw new DevicePublicKeyInvalidException(error.message);
      }
      throw error;
    }
  }

  async attest(input: {
    deviceId: string;
    publicKey: string | null;
    attestation: DeviceAttestationDto | undefined;
  }): Promise<RegisteredDevice> {
    const { mode } = this.config.device.attestation;
    const result = await this.attestationResult(input, mode);
    if (mode === 'enforce' && result !== 'passed') {
      throw new DeviceAttestationFailedException();
    }
    return { publicKey: input.publicKey, attestationResult: result };
  }

  private async attestationResult(
    input: {
      deviceId: string;
      publicKey: string | null;
      attestation: DeviceAttestationDto | undefined;
    },
    mode: 'off' | 'shadow' | 'enforce',
  ): Promise<AttestationResult> {
    const { attestation, publicKey, deviceId } = input;
    if (mode === 'off' || !attestation || !publicKey) {
      return 'unavailable';
    }
    try {
      await this.consumeChallenge(deviceId, 'register', attestation.nonce);
    } catch {
      return 'failed';
    }
    const rawPoint = Buffer.from(publicKey, 'base64')
      .subarray(-P256_RAW_LENGTH)
      .toString('base64');
    return this.attestationVerifier
      .verify({
        platform: attestation.platform,
        keyId: attestation.keyId,
        token: attestation.token,
        clientData: buildSigningString([
          'attest',
          attestation.nonce,
          deviceId,
          rawPoint,
        ]),
      })
      .catch(() => 'unavailable' as const);
  }
}
