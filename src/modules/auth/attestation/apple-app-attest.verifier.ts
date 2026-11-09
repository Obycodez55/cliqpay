import { createHash, X509Certificate } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../../config';
import { AttestationResult } from '../entities/trusted-device.entity';
import { decodeCbor } from './cbor.util';
import { DeviceAttestationInput } from './device-attestation-verifier';

const NONCE_EXTENSION_OID = Buffer.from('2a864886f763640802', 'hex');
const PRODUCTION_AAGUID = Buffer.concat([
  Buffer.from('appattest'),
  Buffer.alloc(7),
]);
const DEVELOPMENT_AAGUID = Buffer.from('appattestdevelop');

interface Tlv {
  tag: number;
  value: Buffer;
  end: number;
}

function readTlv(buffer: Buffer, offset: number): Tlv {
  const tag = buffer[offset];
  let length = buffer[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = buffer.readUIntBE(start, count);
    start += count;
  }
  if (start + length > buffer.length) throw new Error('Truncated DER');
  return {
    tag,
    value: buffer.subarray(start, start + length),
    end: start + length,
  };
}

// The leaf certificate carries SHA-256(authData ‖ clientDataHash) in a
// 1.2.840.113635.100.8.2 extension: OCTET STRING { SEQUENCE { [1] { OCTET STRING } } }.
function readNonceExtension(certDer: Buffer): Buffer {
  const at = certDer.indexOf(NONCE_EXTENSION_OID);
  if (at === -1) throw new Error('Nonce extension missing');
  let cursor = at + NONCE_EXTENSION_OID.length;
  if (certDer[cursor] === 0x01) cursor = readTlv(certDer, cursor).end;
  const wrapper = readTlv(certDer, cursor);
  if (wrapper.tag !== 0x04) throw new Error('Unexpected extension encoding');
  const sequence = readTlv(wrapper.value, 0);
  const tagged = readTlv(sequence.value, 0);
  const nonce = readTlv(tagged.value, 0);
  return nonce.value;
}

@Injectable()
export class AppleAppAttestVerifier {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  verify(input: DeviceAttestationInput): Promise<AttestationResult> {
    const { teamId, bundleId, rootCaPem } =
      this.config.device.attestation.apple;
    if (!input.keyId || !teamId || !bundleId || !rootCaPem) {
      return Promise.resolve('failed');
    }
    try {
      const passed = this.check(input, input.keyId, {
        teamId,
        bundleId,
        rootCaPem,
      });
      return Promise.resolve(passed ? 'passed' : 'failed');
    } catch {
      return Promise.resolve('failed');
    }
  }

  private check(
    input: DeviceAttestationInput,
    keyId: string,
    apple: { teamId: string; bundleId: string; rootCaPem: string },
  ): boolean {
    const object = decodeCbor(Buffer.from(input.token, 'base64'));
    if (!(object instanceof Map)) return false;
    const fields = object as Map<string, unknown>;
    if (fields.get('fmt') !== 'apple-appattest') return false;
    const attStmt = fields.get('attStmt');
    const authData = fields.get('authData');
    if (!(attStmt instanceof Map) || !Buffer.isBuffer(authData)) return false;
    const x5c = (attStmt as Map<string, unknown>).get('x5c');
    if (
      !Array.isArray(x5c) ||
      x5c.length < 2 ||
      !x5c.every((der): der is Buffer => Buffer.isBuffer(der))
    ) {
      return false;
    }

    const chain = x5c.map((der) => new X509Certificate(der));
    const root = new X509Certificate(apple.rootCaPem.replace(/\\n/g, '\n'));
    const now = Date.now();
    for (let i = 0; i < chain.length; i++) {
      const issuer = i + 1 < chain.length ? chain[i + 1] : root;
      const cert = chain[i];
      if (!cert.verify(issuer.publicKey) || !cert.checkIssued(issuer)) {
        return false;
      }
      if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) {
        return false;
      }
    }
    if (!chain[chain.length - 1].verify(root.publicKey)) return false;

    const clientDataHash = createHash('sha256')
      .update(input.clientData)
      .digest();
    const expectedNonce = createHash('sha256')
      .update(Buffer.concat([authData, clientDataHash]))
      .digest();
    const leaf = chain[0];
    if (!readNonceExtension(leaf.raw).equals(expectedNonce)) return false;

    const jwk = leaf.publicKey.export({ format: 'jwk' });
    const point = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x!, 'base64url'),
      Buffer.from(jwk.y!, 'base64url'),
    ]);
    const derivedKeyId = createHash('sha256').update(point).digest();
    if (!derivedKeyId.equals(Buffer.from(keyId, 'base64'))) return false;

    // authData: rpIdHash(32) ‖ flags(1) ‖ counter(4) ‖ aaguid(16) ‖ credIdLen(2) ‖ credId
    if (authData.length < 55) return false;
    const rpIdHash = createHash('sha256')
      .update(`${apple.teamId}.${apple.bundleId}`)
      .digest();
    if (!authData.subarray(0, 32).equals(rpIdHash)) return false;
    if (authData.readUInt32BE(33) !== 0) return false;
    const aaguid = authData.subarray(37, 53);
    const aaguidOk =
      aaguid.equals(PRODUCTION_AAGUID) ||
      (this.config.device.attestation.allowDevelopmentApple &&
        aaguid.equals(DEVELOPMENT_AAGUID));
    if (!aaguidOk) return false;
    const credentialIdLength = authData.readUInt16BE(53);
    const credentialId = authData.subarray(55, 55 + credentialIdLength);
    return credentialId.equals(derivedKeyId);
  }
}
