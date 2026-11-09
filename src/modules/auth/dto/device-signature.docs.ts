export const DEVICE_SIGNATURE_DESCRIPTION = (purpose: string): string =>
  'Base64 ASN.1 DER ECDSA P-256 / SHA-256 signature by the device key over the UTF-8 string ' +
  `\`${purpose}\`, \`nonce\` and \`X-Device-Id\` joined by LF (0x0A): "${purpose}\\n<nonce>\\n<deviceId>". ` +
  'Required while DEVICE_KEY_REQUIRED is on.';
