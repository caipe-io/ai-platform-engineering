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

  it('keeps sign-in available when browser storage is disabled', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Disabled', 'SecurityError'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getLoginCallbackUrl(null, true)).toBe('/');
    expect(warn).toHaveBeenCalled();
  });
});
