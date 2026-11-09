import {
  createCipheriv,
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'crypto';
import { AppConfig } from '../../../../config';
import { GooglePlayIntegrityVerifier } from '../google-play-integrity.verifier';

const PACKAGE = 'ng.cliqpay.app';
const clientData = Buffer.from('attest\nnonce\ndevice-1\nrawpoint');
const nonce = createHash('sha256').update(clientData).digest('base64url');

const aesKey = randomBytes(32);
const { publicKey, privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});

function token(
  payload: Record<string, unknown>,
  signingKey = privateKey,
): string {
  const b64 = (value: object | Buffer) =>
    (Buffer.isBuffer(value)
      ? value
      : Buffer.from(JSON.stringify(value))
    ).toString('base64url');
  const jwsHeader = b64({ alg: 'ES256' });
  const jwsPayload = b64(payload);
  const signature = sign('sha256', Buffer.from(`${jwsHeader}.${jwsPayload}`), {
    key: signingKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  const jws = `${jwsHeader}.${jwsPayload}.${signature}`;

  const cek = randomBytes(32);
  const wrap = createCipheriv(
    'id-aes256-wrap',
    aesKey,
    Buffer.from('A6A6A6A6A6A6A6A6', 'hex'),
  );
  const wrapped = Buffer.concat([wrap.update(cek), wrap.final()]);
  const header = b64({ alg: 'A256KW', enc: 'A256GCM' });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cek, iv);
  cipher.setAAD(Buffer.from(header, 'ascii'));
  const ciphertext = Buffer.concat([cipher.update(jws), cipher.final()]);
  return [
    header,
    wrapped.toString('base64url'),
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

type Payload = ReturnType<typeof goodPayload>;

const goodPayload = () => ({
  requestDetails: {
    requestPackageName: PACKAGE,
    nonce,
    timestampMillis: String(Date.now()),
  },
  appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED' },
  deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
});

describe('GooglePlayIntegrityVerifier', () => {
  const verifier = new GooglePlayIntegrityVerifier({
    device: {
      attestation: {
        google: {
          packageName: PACKAGE,
          decryptionKey: aesKey.toString('base64'),
          verificationKey: publicKey
            .export({ format: 'der', type: 'spki' })
            .toString('base64'),
        },
      },
    },
  } as unknown as AppConfig);
  const run = (value: string) =>
    verifier.verify({ platform: 'android', token: value, clientData });

  it('passes a well-formed token for this app, nonce and a genuine device', () => {
    expect(run(token(goodPayload()))).toBe('passed');
  });

  it.each([
    [
      'wrong package',
      (p: Payload) => (p.requestDetails.requestPackageName = 'x'),
    ],
    ['wrong nonce', (p: Payload) => (p.requestDetails.nonce = 'other')],
    [
      'stale token',
      (p: Payload) => (p.requestDetails.timestampMillis = '1000'),
    ],
    [
      'unrecognized app',
      (p: Payload) =>
        (p.appIntegrity.appRecognitionVerdict = 'UNRECOGNIZED_VERSION'),
    ],
    [
      'no device integrity',
      (p: Payload) => (p.deviceIntegrity.deviceRecognitionVerdict = []),
    ],
  ])('fails on %s', (_name, mutate) => {
    const payload = goodPayload();
    mutate(payload);

    expect(run(token(payload))).toBe('failed');
  });

  it('fails when Google’s signature does not verify, or the token is garbage', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

    expect(run(token(goodPayload(), other.privateKey))).toBe('failed');
    expect(run('a.b.c.d.e')).toBe('failed');
    expect(run('garbage')).toBe('failed');
  });
});
