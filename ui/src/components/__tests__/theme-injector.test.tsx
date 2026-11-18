/**
 * Unit tests for ThemeInjector component
 *
 * Tests:
 * - Applies gradient CSS custom properties from config
 * - Applies spinner color from config
 * - Sets data-gradient-theme attribute from config default
 * - Does not overwrite existing data-gradient-theme (user override)
 * - Handles null/empty config values gracefully
 */

import React from 'react';
import { render } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

let mockConfigValues: Record<string, unknown> = {};

jest.mock('@/lib/config', () => ({
  getConfig: (key: string) => mockConfigValues[key],
}));

// ============================================================================
// Helpers
// ============================================================================

function resetDOM() {
  const root = document.documentElement;
  root.style.removeProperty('--gradient-from');
  root.style.removeProperty('--gradient-to');
  root.style.removeProperty('--spinner-color');
  root.removeAttribute('data-gradient-theme');
}

// Import after mocks
import { ThemeInjector } from '../theme-injector';

// ============================================================================
// Tests
// ============================================================================

describe('ThemeInjector', () => {
  beforeEach(() => {
    mockConfigValues = {
      gradientFrom: 'hsl(173,80%,40%)',
      gradientTo: 'hsl(270,75%,60%)',
      spinnerColor: null,
      defaultGradientTheme: 'default',
    };
    resetDOM();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Gradient CSS Custom Properties
  // --------------------------------------------------------------------------

  describe('Gradient CSS Variables', () => {
    it('sets --gradient-from from config', () => {
      render(<ThemeInjector />);
      expect(
        document.documentElement.style.getPropertyValue('--gradient-from'),
      ).toBe('hsl(173,80%,40%)');
    });

    it('sets --gradient-to from config', () => {
      render(<ThemeInjector />);
      expect(
        document.documentElement.style.getPropertyValue('--gradient-to'),
      ).toBe('hsl(270,75%,60%)');
    });

    it('applies custom gradient colors from env config', () => {
      mockConfigValues.gradientFrom = '#ff0000';
      mockConfigValues.gradientTo = '#0000ff';

      render(<ThemeInjector />);

      expect(
        document.documentElement.style.getPropertyValue('--gradient-from'),
      ).toBe('#ff0000');
      expect(
        document.documentElement.style.getPropertyValue('--gradient-to'),
      ).toBe('#0000ff');
    });

    it('does not set --gradient-from when config value is empty', () => {
      mockConfigValues.gradientFrom = '';

      render(<ThemeInjector />);

      expect(
        document.documentElement.style.getPropertyValue('--gradient-from'),
      ).toBe('');
    });

    it('does not set --gradient-to when config value is empty', () => {
      mockConfigValues.gradientTo = '';

      render(<ThemeInjector />);

      expect(
        document.documentElement.style.getPropertyValue('--gradient-to'),
      ).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  // Spinner Color
  // --------------------------------------------------------------------------

  describe('Spinner Color', () => {
    it('sets --spinner-color when config provides a value', () => {
      mockConfigValues.spinnerColor = '#4ecdc4';

      render(<ThemeInjector />);

      expect(
        document.documentElement.style.getPropertyValue('--spinner-color'),
      ).toBe('#4ecdc4');
    });

    it('does not set --spinner-color when config value is null', () => {
      mockConfigValues.spinnerColor = null;

      render(<ThemeInjector />);

      expect(
        document.documentElement.style.getPropertyValue('--spinner-color'),
      ).toBe('');
    });

    it('does not set --spinner-color when config value is empty string', () => {
      mockConfigValues.spinnerColor = '';

      render(<ThemeInjector />);

      expect(
        document.documentElement.style.getPropertyValue('--spinner-color'),
      ).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  // Default Gradient Theme Attribute
  // --------------------------------------------------------------------------

  describe('data-gradient-theme Attribute', () => {
    it('sets data-gradient-theme from config when not already set', () => {
      mockConfigValues.defaultGradientTheme = 'professional';

      render(<ThemeInjector />);

      expect(
        document.documentElement.getAttribute('data-gradient-theme'),
      ).toBe('professional');
    });

    it('does not overwrite existing data-gradient-theme (user override)', () => {
      document.documentElement.setAttribute('data-gradient-theme', 'sunset');
      mockConfigValues.defaultGradientTheme = 'professional';

      render(<ThemeInjector />);

      expect(
        document.documentElement.getAttribute('data-gradient-theme'),
      ).toBe('sunset');
    });

    it('does not set data-gradient-theme when config value is empty', () => {
      mockConfigValues.defaultGradientTheme = '';

      render(<ThemeInjector />);

      expect(
        document.documentElement.getAttribute('data-gradient-theme'),
      ).toBeNull();
    });

    it('does not set data-gradient-theme when config value is null', () => {
      mockConfigValues.defaultGradientTheme = null;

      render(<ThemeInjector />);

      expect(
        document.documentElement.getAttribute('data-gradient-theme'),
      ).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Combined Behavior
  // --------------------------------------------------------------------------

  describe('Combined Behavior', () => {
    it('applies all config values together', () => {
      mockConfigValues = {
        gradientFrom: '#1a1a2e',
        gradientTo: '#16213e',
        spinnerColor: '#e94560',
        defaultGradientTheme: 'ocean',
      };

      render(<ThemeInjector />);

      const root = document.documentElement;
      expect(root.style.getPropertyValue('--gradient-from')).toBe('#1a1a2e');
      expect(root.style.getPropertyValue('--gradient-to')).toBe('#16213e');
      expect(root.style.getPropertyValue('--spinner-color')).toBe('#e94560');
      expect(root.getAttribute('data-gradient-theme')).toBe('ocean');
    });

    it('renders null (no visible DOM output)', () => {
      const { container } = render(<ThemeInjector />);
      expect(container.innerHTML).toBe('');
    });

    it('does not log theme values by default', () => {
      const logSpy = jest.spyOn(console, 'log');

      render(<ThemeInjector />);

      expect(logSpy).not.toHaveBeenCalled();
    });

    it('logs applied theme values when uiDebugLogging is enabled', () => {
      mockConfigValues.uiDebugLogging = true;
      const logSpy = jest.spyOn(console, 'log');

      render(<ThemeInjector />);

      expect(logSpy).toHaveBeenCalledWith(
        '[ThemeInjector] Applying theme:',
        expect.objectContaining({
          gradientFrom: expect.any(String),
          gradientTo: expect.any(String),
          defaultGradientTheme: expect.any(String),
        }),
      );
    });
  });
});
