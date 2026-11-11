import {
  clearLoginReturnTo,
  getLoginCallbackUrl,
  LOGIN_RETURN_TO_KEY,
  normalizeCallbackUrl,
  rememberLoginReturnTo,
} from '../callback-url';

const origin = 'https://host.example';

describe('login callback validation', () => {
  it.each([
    ['/chat/example?tab=activity#details', '/chat/example?tab=activity#details'],
    [`${origin}/chat/example?tab=activity`, '/chat/example?tab=activity'],
    ['/apps/example?repo=example%2Frepo&report=saved', '/apps/example?repo=example%2Frepo&report=saved'],
    ['/api/auth/example/start?retry=true', '/api/auth/example/start?retry=true'],
    ['/schedules?path=a\\b#section\\details', '/schedules?path=a\\b#section\\details'],
    [`${origin}/schedules?path=a\\b#section\\details`, '/schedules?path=a\\b#section\\details'],
  ])('retains a safe destination %s', (value, expected) => {
    expect(normalizeCallbackUrl(value, origin)).toBe(expected);
  });

  it.each([
    null, '', 'chat/example', '//outside.example/chat',
    'https://outside.example/chat', 'http://host.example/chat',
    'https://host.example:444/chat', 'https://host.example@outside.example/chat',
    'https://user@host.example/chat', '/\\outside.example/chat',
    '/chat/\nexample', '/.//outside.example', 'javascript:alert(1)',
    '/login?callbackUrl=%2Fchat%2Fexample', `${origin}/login?error=OAuthCallback`,
    '/example/../login',
    '/chat\\example?path=a\\b', `${origin}\\outside.example/chat?path=a\\b`,
    `/${'a'.repeat(8192)}`,
  ])('rejects an external, malformed, or looping destination %s', value => {
    expect(normalizeCallbackUrl(value, origin)).toBe('/');
  });

  it('does not accept an absolute URL without a trusted origin', () => {
    expect(normalizeCallbackUrl(`${origin}/chat/example`)).toBe('/');
  });
});

describe('tab-local login retry destination', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => jest.restoreAllMocks());

  it('restores an attempted destination only during login recovery', () => {
    rememberLoginReturnTo('/chat/example?tab=activity');
    expect(getLoginCallbackUrl(null, true)).toBe('/chat/example?tab=activity');
    expect(getLoginCallbackUrl(null)).toBe('/');
  });

  it('gives the URL parameter priority over a previous attempt', () => {
    rememberLoginReturnTo('/chat/previous');
    expect(getLoginCallbackUrl('/chat/current', true)).toBe('/chat/current');
    expect(getLoginCallbackUrl('https://outside.example/chat', true)).toBe('/');
  });

  it.each([
    '/login?callbackUrl=%2Fchat%2Fother',
    'https://outside.example/login?callbackUrl=%2Fchat%2Fexample',
    '/login?callbackUrl=https%3A%2F%2Foutside.example%2Fchat',
    '/login?callbackUrl=%2Flogin%3FcallbackUrl%3D%252Fchat%252Fexample',
  ])('rejects an untrusted or mismatched OAuth return wrapper %s', callback => {
    rememberLoginReturnTo('/chat/example#details');
    expect(getLoginCallbackUrl(callback, true)).toBe('/');
  });

  it('unwraps a fragment callback only for a matching pending OAuth retry', () => {
    const callback = '/login?callbackUrl=%2Fchat%2Fexample';
    expect(getLoginCallbackUrl(callback, true)).toBe('/');
    rememberLoginReturnTo('/chat/example#details');
    expect(getLoginCallbackUrl(callback)).toBe('/');
    expect(getLoginCallbackUrl(callback, true)).toBe('/chat/example#details');
  });

  it.each([Date.now() - 16 * 60_000, Date.now() + 60_000])('discards expired or future records', savedAt => {
    sessionStorage.setItem(LOGIN_RETURN_TO_KEY, JSON.stringify({ path: '/chat/example', savedAt }));
    expect(getLoginCallbackUrl(null, true)).toBe('/');
    expect(sessionStorage.getItem(LOGIN_RETURN_TO_KEY)).toBeNull();
  });

  it('revalidates the destination read from storage', () => {
    sessionStorage.setItem(LOGIN_RETURN_TO_KEY, JSON.stringify({ path: 'https://outside.example/chat', savedAt: Date.now() }));
    expect(getLoginCallbackUrl(null, true)).toBe('/');
    expect(sessionStorage.getItem(LOGIN_RETURN_TO_KEY)).toBeNull();
  });

  it('clears the destination after successful authentication or an explicit home login', () => {
    rememberLoginReturnTo('/chat/example');
    clearLoginReturnTo();
    expect(getLoginCallbackUrl(null, true)).toBe('/');
    rememberLoginReturnTo('/chat/example');
    rememberLoginReturnTo('/');
    expect(getLoginCallbackUrl(null, true)).toBe('/');
  });

  it.each(['{', 'null', '[]', '1', 'true', '"record"', '{}',
    '{"path":"/chat/example","savedAt":"invalid"}',
  ])('silently discards a corrupt recovery record %s', record => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    sessionStorage.setItem(LOGIN_RETURN_TO_KEY, record);
    expect(getLoginCallbackUrl(null, true)).toBe('/');
    expect(sessionStorage.getItem(LOGIN_RETURN_TO_KEY)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps sign-in available when browser storage is disabled', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Disabled', 'SecurityError'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getLoginCallbackUrl(null, true)).toBe('/');
    expect(warn).toHaveBeenCalled();
  });
});
