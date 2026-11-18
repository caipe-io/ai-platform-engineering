/**
 * @jest-environment jsdom
 */
import { debugLog, isDebugLoggingEnabled } from '../debug-log';

type WithConfig = { __APP_CONFIG__?: { uiDebugLogging?: boolean } };

describe('debugLog', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete (window as unknown as WithConfig).__APP_CONFIG__;
  });

  it('is silent when the config is not injected', () => {
    debugLog('hello');
    expect(isDebugLoggingEnabled()).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('is silent when uiDebugLogging is false', () => {
    (window as unknown as WithConfig).__APP_CONFIG__ = { uiDebugLogging: false };
    debugLog('hello');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('logs when uiDebugLogging is true, reading the flag at call time', () => {
    debugLog('before');
    (window as unknown as WithConfig).__APP_CONFIG__ = { uiDebugLogging: true };
    debugLog('after', { a: 1 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('after', { a: 1 });
  });
});
