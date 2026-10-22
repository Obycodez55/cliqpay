import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { ValidationError, validate } from 'class-validator';
import { VerifyBvnDto } from '../dto/verify-bvn.dto';
import { MAX_LIVENESS_IMAGE_BASE64_LENGTH } from '../dto/liveness-capture.dto';

const JPEG = '/9j/AA==';

function body(liveness: Record<string, unknown>) {
  return plainToInstance(VerifyBvnDto, { bvn: '12345678901', liveness });
}

function capture(overrides: Record<string, unknown> = {}) {
  return {
    selfieImage: JPEG,
    livenessImages: Array<string>(6).fill(JPEG),
    consentGranted: true,
    ...overrides,
  };
}

function collectMessages(errors: ValidationError[]): string[] {
  return errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...collectMessages(error.children ?? []),
  ]);
}

async function messages(dto: VerifyBvnDto): Promise<string> {
  return collectMessages(await validate(dto)).join(' ');
}

describe('LivenessCaptureDto', () => {
  it('accepts a request without liveness', async () => {
    const dto = plainToInstance(VerifyBvnDto, { bvn: '12345678901' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts a valid capture', async () => {
    expect(await validate(body(capture()))).toHaveLength(0);
  });

  it.each([
    ['non-base64 selfie', { selfieImage: 'not base64!!' }],
    ['non-JPEG selfie', { selfieImage: 'aGVsbG8=' }],
    [
      'oversized selfie',
      { selfieImage: '/9j/' + 'A'.repeat(MAX_LIVENESS_IMAGE_BASE64_LENGTH) },
    ],
    ['too few liveness frames', { livenessImages: Array(5).fill(JPEG) }],
    ['too many liveness frames', { livenessImages: Array(9).fill(JPEG) }],
    [
      'an invalid liveness frame',
      { livenessImages: [...Array<string>(5).fill(JPEG), '%%%'] },
    ],
    ['missing consent', { consentGranted: false }],
  ])('rejects %s', async (_label, overrides) => {
    expect(await validate(body(capture(overrides)))).not.toHaveLength(0);
  });

  it('never echoes the submitted image in a validation message', async () => {
    const bad = 'NOT-A-JPEG-' + 'A'.repeat(200);

    const text = await messages(body(capture({ selfieImage: bad })));

    expect(text).toContain('selfieImage');
    expect(text).not.toContain('NOT-A-JPEG');
  });
});
