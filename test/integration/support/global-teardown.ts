export default async function globalTeardown(): Promise<void> {
  await globalThis.__CLIQPAY_TEST_PG__?.stop();
}
