import {
  deviceIntegrity,
  muleFanIn,
  newAccountLargeWithdrawal,
  sendBurst,
  sharedDevice,
  taintedInflow,
} from '../internal/rules';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('muleFanIn', () => {
  const params = {
    minDistinctSenders: 5,
    windowHours: 24,
    minWithdrawalSharePercent: 50,
  };
  const inflows = (count: number, each = 100n) =>
    Array.from({ length: count }, (_, i) => ({
      senderUserId: `sender-${i}`,
      total: each,
    }));

  it('trips at 5 senders when the withdrawal is half the inflow', () => {
    expect(muleFanIn(params, 250n, inflows(5))?.evidence).toMatchObject({
      distinctSenders: 5,
      inflowMinor: '500',
      withdrawalMinor: '250',
    });
  });

  it('does not trip with 4 senders', () => {
    expect(muleFanIn(params, 400n, inflows(4))).toBeNull();
  });

  it('does not trip when the withdrawal is under half the inflow', () => {
    expect(muleFanIn(params, 249n, inflows(5))).toBeNull();
  });

  it('counts a single sender once, whatever the number of sends', () => {
    expect(
      muleFanIn(params, 1_000n, [{ senderUserId: 'a', total: 1_000n }]),
    ).toBeNull();
  });
});

describe('newAccountLargeWithdrawal', () => {
  const params = { maxAccountAgeDays: 7, minAmountMinor: 10_000_000 };

  it('trips for a young account at the amount threshold', () => {
    expect(
      newAccountLargeWithdrawal(params, 10_000_000n, 6 * DAY_MS),
    ).not.toBeNull();
  });

  it('does not trip below the amount', () => {
    expect(
      newAccountLargeWithdrawal(params, 9_999_999n, 1 * DAY_MS),
    ).toBeNull();
  });

  it('does not trip once the account is 7 days old', () => {
    expect(
      newAccountLargeWithdrawal(params, 50_000_000n, 7 * DAY_MS),
    ).toBeNull();
  });
});

describe('taintedInflow', () => {
  const params = { minAmountMinor: 500_000, windowHours: 72 };
  const flagged = new Set(['bad']);

  it('trips when enough came from flagged senders', () => {
    const hit = taintedInflow(
      params,
      [
        { senderUserId: 'bad', total: 500_000n },
        { senderUserId: 'ok', total: 9_000_000n },
      ],
      flagged,
    );
    expect(hit?.evidence).toMatchObject({
      taintedSenders: ['bad'],
      taintedInflowMinor: '500000',
    });
  });

  it('ignores inflow from clean senders however large', () => {
    expect(
      taintedInflow(
        params,
        [{ senderUserId: 'ok', total: 9_000_000n }],
        flagged,
      ),
    ).toBeNull();
  });

  it('does not trip under the threshold', () => {
    expect(
      taintedInflow(
        params,
        [{ senderUserId: 'bad', total: 499_999n }],
        flagged,
      ),
    ).toBeNull();
  });

  it('adds up several flagged senders', () => {
    expect(
      taintedInflow(
        params,
        [
          { senderUserId: 'bad', total: 300_000n },
          { senderUserId: 'worse', total: 200_000n },
        ],
        new Set(['bad', 'worse']),
      ),
    ).not.toBeNull();
  });
});

describe('sendBurst', () => {
  const params = {
    burstSends: 10,
    burstWindowMinutes: 10,
    newRecipients: 5,
    newRecipientWindowMinutes: 60,
  };

  it('trips on 10 sends', () => {
    expect(
      sendBurst(params, { sends: 10, firstTimeRecipients: 0 }),
    ).not.toBeNull();
  });

  it('trips on 5 first-time recipients', () => {
    expect(
      sendBurst(params, { sends: 5, firstTimeRecipients: 5 }),
    ).not.toBeNull();
  });

  it('does not trip under both', () => {
    expect(sendBurst(params, { sends: 9, firstTimeRecipients: 4 })).toBeNull();
  });
});

describe('sharedDevice', () => {
  const params = { minUsers: 3, windowDays: 30 };

  it('trips at 3 users', () => {
    expect(sharedDevice(params, 'dev-1', 3)?.evidence).toEqual({
      deviceId: 'dev-1',
      usersOnDevice: 3,
    });
  });

  it('does not trip at 2', () => {
    expect(sharedDevice(params, 'dev-1', 2)).toBeNull();
  });
});

describe('deviceIntegrity', () => {
  it('trips only on a failed attestation', () => {
    expect(deviceIntegrity('dev-1', 'failed')).not.toBeNull();
    expect(deviceIntegrity('dev-1', 'passed')).toBeNull();
    expect(deviceIntegrity('dev-1', 'unavailable')).toBeNull();
  });
});
