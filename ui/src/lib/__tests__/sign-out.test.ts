import { signOut } from 'next-auth/react';
import { signOutWithFeedback } from '../sign-out';
jest.mock('next-auth/react', () => ({ signOut: jest.fn() }));
beforeEach(() => { jest.spyOn(window, 'alert').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); });

it('checks revocation errors even when the NextAuth client resolves its promise', async () => {
  jest.mocked(signOut).mockResolvedValueOnce({ error: 'unavailable' } as never);
  expect(await signOutWithFeedback({ redirect: false })).toBe(false);
  expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Please retry'));
});
it('returns success after confirmed logout', async () => {
  jest.mocked(signOut).mockResolvedValueOnce({ url: '/login' });
  expect(await signOutWithFeedback({ redirect: false })).toBe(true);
  expect(window.alert).not.toHaveBeenCalled();
});
