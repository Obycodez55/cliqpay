import { UnrecoverableError } from 'bullmq';
import {
  classifyHttpFailure,
  maybeThrowSentinelFailure,
} from '../internal/errors';

describe('classifyHttpFailure', () => {
  it.each([undefined, 429, 500, 503])(
    'throws a plain (retryable) Error for status %s',
    (status) => {
      let caught: unknown;
      try {
        classifyHttpFailure(status, 'boom');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(UnrecoverableError);
    },
  );

  it.each([400, 401, 403, 404, 422])(
    'throws UnrecoverableError (non-retryable) for status %s',
    (status) => {
      expect(() => classifyHttpFailure(status, 'boom')).toThrow(
        UnrecoverableError,
      );
    },
  );
});

describe('maybeThrowSentinelFailure', () => {
  it('does nothing for an ordinary recipient', () => {
    expect(() =>
      maybeThrowSentinelFailure('user@example.com', 'test'),
    ).not.toThrow();
  });

  it('throws UnrecoverableError for a +fail-permanent sentinel', () => {
    expect(() =>
      maybeThrowSentinelFailure('user+fail-permanent@example.com', 'test'),
    ).toThrow(UnrecoverableError);
  });

  it('throws a plain Error for a +fail-transient sentinel', () => {
    let caught: unknown;
    try {
      maybeThrowSentinelFailure('user+fail-transient@example.com', 'test');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UnrecoverableError);
  });
});
