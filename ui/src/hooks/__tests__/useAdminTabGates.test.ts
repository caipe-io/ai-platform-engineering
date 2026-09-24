import { renderHook, waitFor } from '@testing-library/react';
import { useAdminTabGates } from '../useAdminTabGates';

const mockUseSession = jest.fn();
jest.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}));

describe('useAdminTabGates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock) = jest.fn();
  });

  it('does not fetch when unauthenticated', async () => {
    mockUseSession.mockReturnValue({ data: null, status: 'unauthenticated' });

    const { result } = renderHook(() => useAdminTabGates());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.current.visibleTabs).toEqual([]);
  });

  it('fetches gates when authenticated without accessToken (email session only)', async () => {
    mockUseSession.mockReturnValue({
      data: { user: { email: 'a@b.com' } },
      status: 'authenticated',
    });

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        gates: {
          users: true,
          teams: true,
          roles: false,
          slack: false,
          skills: false,
          feedback: false,
          stats: false,
          metrics: false,
          health: false,
          audit_logs: false,
          action_audit: false,
          openfga: false,
          migrations: false,
        },
      }),
    });

    const { result } = renderHook(() => useAdminTabGates());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/rbac/admin-tab-gates');
    expect(result.current.visibleTabs).toEqual(['users', 'teams']);
  });

  it('fetches gates when authenticated and maps visible tabs', async () => {
    mockUseSession.mockReturnValue({
      data: { accessToken: 'tok1' },
      status: 'authenticated',
    });

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        gates: {
          users: true,
          teams: false,
          roles: true,
          slack: false,
          skills: false,
          feedback: false,
          stats: false,
          metrics: false,
          health: false,
          audit_logs: false,
          action_audit: false,
          openfga: false,
          migrations: false,
        },
      }),
    });

    const { result } = renderHook(() => useAdminTabGates());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/rbac/admin-tab-gates');
    expect(result.current.visibleTabs).toEqual(['users', 'roles']);
    expect(result.current.error).toBeNull();
  });

  it('sets error and fail-closed gates on HTTP error', async () => {
    mockUseSession.mockReturnValue({
      data: { accessToken: 'tok2' },
      status: 'authenticated',
    });

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 503,
    });

    const { result } = renderHook(() => useAdminTabGates());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toContain('503');
    expect(result.current.visibleTabs).toEqual([]);
  });
});
