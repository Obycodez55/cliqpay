import { plainToInstance } from 'class-transformer';
import { RegisterDto } from '../../../src/modules/auth/dto/register.dto';
import { TokenPairResponseDto } from '../../../src/modules/auth/dto/token-pair-response.dto';
import { DeviceMetadata } from '../../../src/modules/auth/internal/device-metadata.util';
import { EmailMessage } from '../../../src/modules/notifications/channels/email/email-sender.interface';
import { SmsMessage } from '../../../src/modules/notifications/channels/sms/sms-sender.interface';
import { AuthTestContext } from './auth-test-context';

export const TEST_DEVICE: DeviceMetadata = {
  ipAddress: '203.0.113.10',
  userAgent: 'jest-integration-test-agent',
};

export const SIGN_IN_CODE_SUBJECT = 'Your Cliqpay sign-in code';
export const SECURITY_ALERT_SUBJECT = 'Security alert on your Cliqpay account';
export const PASSWORD_RESET_SUBJECT = 'Reset your Cliqpay password';

export function registerPayload(
  overrides: Record<string, unknown> = {},
): RegisterDto {
  return plainToInstance(RegisterDto, {
    email: 'ada@example.com',
    password: 'a-strong-unique-passphrase',
    firstName: 'Ada',
    lastName: 'Lovelace',
    username: 'ada_l',
    phone: '+2348012345678',
    ...overrides,
  });
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The MFA code is the only 6-digit run in the rendered email — see
// templates/email/mfa-challenge-otp.hbs.
export function extractSixDigitCode(text: string): string {
  const match = text.match(/\b(\d{6})\b/);
  if (!match) {
    throw new Error(`No 6-digit code found in email text: ${text}`);
  }
  return match[1];
}

// Deterministically wrong — collision-free, unlike picking a fixed guess
// that could rarely equal the real code.
export function wrongCodeFor(correctCode: string): string {
  const next = (parseInt(correctCode, 10) + 1) % 1_000_000;
  return next.toString().padStart(6, '0');
}

export interface AuthTestHelpers {
  registerUser: (
    overrides?: Record<string, unknown>,
  ) => ReturnType<AuthTestContext['authService']['register']>;
  waitForVerificationEmail: (email: string) => Promise<EmailMessage>;
  waitForVerificationSms: (phone: string) => Promise<SmsMessage>;
  waitForPasswordResetEmail: (email: string) => Promise<EmailMessage>;
  latestEmailWithSubject: (subject: string) => EmailMessage;
  agePastResendCooldown: (
    userId: string,
    purpose: 'email_verification' | 'phone_verification',
  ) => Promise<void>;
  loginAndVerify: (
    email: string,
    password: string,
  ) => Promise<{ tokens: TokenPairResponseDto; trustedDeviceToken: string }>;
}

export function createAuthTestHelpers(ctx: AuthTestContext): AuthTestHelpers {
  const {
    authService,
    sessionService,
    emailAdapter,
    smsAdapter,
    verificationCodeRepo,
  } = ctx;

  function registerUser(overrides: Record<string, unknown> = {}) {
    return authService.register(registerPayload(overrides));
  }

  // register()'s verification-send is fire-and-forget — can't assume it's
  // landed in emailAdapter.sent right after register() resolves.
  async function waitForVerificationEmail(
    email: string,
  ): Promise<EmailMessage> {
    await waitFor(() => emailAdapter.sent.some((m) => m.to === email));
    return emailAdapter.sent.find((m) => m.to === email)!;
  }

  // Fire-and-forget means this can interleave with other sends to the same
  // recipient, so `.sent.at(-1)` isn't reliable — filter by subject instead.
  function latestEmailWithSubject(subject: string): EmailMessage {
    const matches = emailAdapter.sent.filter((m) => m.subject === subject);
    if (matches.length === 0) {
      throw new Error(`No sent email found with subject "${subject}"`);
    }
    return matches[matches.length - 1];
  }

  async function waitForPasswordResetEmail(
    email: string,
  ): Promise<EmailMessage> {
    await waitFor(() =>
      emailAdapter.sent.some(
        (m) => m.to === email && m.subject === PASSWORD_RESET_SUBJECT,
      ),
    );
    return emailAdapter.sent
      .filter((m) => m.to === email && m.subject === PASSWORD_RESET_SUBJECT)
      .at(-1)!;
  }

  // register()'s verification-send is fire-and-forget — can't assume it's
  // landed in smsAdapter.sent right after register() resolves.
  async function waitForVerificationSms(phone: string): Promise<SmsMessage> {
    await waitFor(() => smsAdapter.sent.some((m) => m.to === phone));
    return smsAdapter.sent.find((m) => m.to === phone)!;
  }

  // Registration always issues an email_verification and a
  // phone_verification code fire-and-forget, and changeEmail/changePhone
  // are rate-limited against those same purposes (they can bomb an
  // arbitrary third-party address otherwise). Tests that aren't exercising
  // that rate limit itself need to step past registration's own code first,
  // same as the resend tests do, rather than sleeping the test for real
  // cooldown time.
  async function agePastResendCooldown(
    userId: string,
    purpose: 'email_verification' | 'phone_verification',
  ): Promise<void> {
    await verificationCodeRepo.update(
      { userId, purpose },
      { createdAt: new Date(Date.now() - 61_000) },
    );
  }

  // login() forks on device trust — this drives it through the
  // untrusted-device path via the real email dispatch and returns finished
  // tokens, for tests that just need a working session.
  async function loginAndVerify(
    email: string,
    password: string,
  ): Promise<{ tokens: TokenPairResponseDto; trustedDeviceToken: string }> {
    const result = await sessionService.login(
      { email, password },
      null,
      TEST_DEVICE,
    );
    if (!result.mfaRequired) {
      throw new Error(
        'loginAndVerify expected an MFA challenge — device was unexpectedly already trusted',
      );
    }
    const code = extractSixDigitCode(
      latestEmailWithSubject(SIGN_IN_CODE_SUBJECT).text,
    );
    return sessionService.verifyMfaChallenge(
      { challengeId: result.challengeId, code },
      TEST_DEVICE,
    );
  }

  return {
    registerUser,
    waitForVerificationEmail,
    waitForVerificationSms,
    waitForPasswordResetEmail,
    latestEmailWithSubject,
    agePastResendCooldown,
    loginAndVerify,
  };
}
