/**
 * @jest-environment jsdom
 */
/**
 * chat-store debug helpers: window.__caipeDebug exists only when the
 * uiDebugLogging runtime flag is on.
 */

// ============================================================================
// Mocks — must be before imports
// ============================================================================

// Use global to avoid TDZ issues with jest.mock factories
(global as unknown).__mockStorageMode = 'mongodb';

jest.mock('@/lib/api-client', () => ({
  apiClient: {
    addMessage: jest.fn().mockResolvedValue({}),
    getMessages: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    getConversations: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100, has_more: false }),
    createConversation: jest.fn().mockResolvedValue({ conversation: { _id: 'server-generated-id' }, created: true }),
    deleteConversation: jest.fn().mockResolvedValue({ deleted: true }),
    updateConversation: jest.fn().mockResolvedValue({}),
    rewindConversation: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('@/lib/storage-config', () => ({
  getStorageMode: () => (global as unknown).__mockStorageMode,
  shouldUseLocalStorage: () => (global as unknown).__mockStorageMode === 'localStorage',
}));

jest.mock('@/lib/utils', () => ({
  generateId: () => `test-id-${Math.random().toString(36).slice(2, 9)}`,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

type DebugWindow = Window & {
  __APP_CONFIG__?: { uiDebugLogging?: boolean };
  __caipeDebug?: unknown;
};

async function loadStore(): Promise<void> {
  await jest.isolateModulesAsync(async () => {
    await import('../chat-store');
  });
}

describe('chat-store debug helpers', () => {
  const w = window as unknown as DebugWindow;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    delete w.__caipeDebug;
    delete w.__APP_CONFIG__;
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete w.__caipeDebug;
    delete w.__APP_CONFIG__;
  });

  it('does not expose __caipeDebug by default', async () => {
    await loadStore();
    expect(w.__caipeDebug).toBeUndefined();
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain('__caipeDebug');
  });

  it('does not expose __caipeDebug in production (flag forced off)', async () => {
    w.__APP_CONFIG__ = { uiDebugLogging: false };
    await loadStore();
    expect(w.__caipeDebug).toBeUndefined();
  });

  it('exposes __caipeDebug when uiDebugLogging is on', async () => {
    w.__APP_CONFIG__ = { uiDebugLogging: true };
    await loadStore();
    expect(w.__caipeDebug).toBeDefined();
  });
});
