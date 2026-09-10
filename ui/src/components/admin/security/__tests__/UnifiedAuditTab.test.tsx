import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import JSZip from 'jszip';
import { UnifiedAuditTab } from '../UnifiedAuditTab';

// assisted-by Codex Codex-sonnet-4-6

describe('UnifiedAuditTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock) = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        records: [],
        total: 0,
        page: 1,
        limit: 30,
      }),
    });
  });

  it('shows admin required message when not admin (fetch still runs before gate)', async () => {
    render(<UnifiedAuditTab isAdmin={false} />);
    expect(
      screen.getByText(/Admin access required to view audit events/i)
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  it('loads audit events when admin', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        records: [
          {
            id: '1',
            ts: new Date().toISOString(),
            type: 'auth',
            outcome: 'allow',
            action: 'admin_ui#view',
            tenant_id: 'default',
            subject_hash: 'h',
            correlation_id: 'c',
            source: 'bff',
          },
        ],
        total: 1,
        page: 1,
        limit: 30,
      }),
    });

    render(<UnifiedAuditTab isAdmin />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("window=5m"),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("time_resolution=minute"),
    );
    expect(await screen.findByText(/RBAC Audit Log/i)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Last 5 min$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^All event types$/i })).toBeInTheDocument();
    expect(screen.queryByText(/Default view hides routine admin page-view checks/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^All types$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/admin_ui#view/i)).toBeInTheDocument();
    expect(screen.getByText(/webui_backend/i)).toBeInTheDocument();
    expect(screen.queryByText(/^bff$/i)).not.toBeInTheDocument();
  });

  it('shows where audit log storage is coming from', async () => {
    (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
      if (url.includes('/api/audit/config')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            backend: 'service',
            readsAvailable: true,
            storageBackend: 's3',
            storageLabel: 'Storage: audit-service -> S3',
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          records: [],
          total: 0,
          page: 1,
          limit: 30,
        }),
      });
    });

    render(<UnifiedAuditTab isAdmin />);

    expect(await screen.findByText(/Storage: audit-service -> S3/i)).toBeInTheDocument();
  });

  it('shows degraded audit storage status when reads are unavailable', async () => {
    (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
      if (url.includes('/api/audit/config')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            backend: 'service',
            readsAvailable: false,
            storageLabel: 'Storage: audit-service unavailable',
            readsWarning: 'audit-service returned HTTP 503',
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          records: [],
          total: 0,
          page: 1,
          limit: 30,
        }),
      });
    });

    render(<UnifiedAuditTab isAdmin />);

    const badge = await screen.findByText(/Storage: audit-service unavailable/i);
    expect(badge).toBeInTheDocument();
    expect(badge.closest('[title]')).toHaveAttribute('title', 'audit-service returned HTTP 503');
  });

  it('refreshes audit storage status with the event refresh button', async () => {
    let configCalls = 0;
    (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
      if (url.includes('/api/audit/config')) {
        configCalls += 1;
        return Promise.resolve({
          ok: true,
          json: async () =>
            configCalls === 1
              ? {
                  backend: 'service',
                  readsAvailable: false,
                  storageLabel: 'Storage: audit-service unavailable',
                  readsWarning: 'This operation was aborted',
                }
              : {
                  backend: 'service',
                  readsAvailable: true,
                  storageBackend: 's3',
                  storageLabel: 'Storage: audit-service -> S3',
                },
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          records: [],
          total: 0,
          page: 1,
          limit: 30,
        }),
      });
    });

    render(<UnifiedAuditTab isAdmin />);

    expect(await screen.findByText(/Storage: audit-service unavailable/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/i }));
    expect(await screen.findByText(/Storage: audit-service -> S3/i)).toBeInTheDocument();
    expect(configCalls).toBeGreaterThanOrEqual(2);
  });

  it('renders OpenFGA ReBAC audit events as their own type', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        records: [
          {
            id: '1',
            ts: new Date().toISOString(),
            type: 'openfga_rebac',
            outcome: 'allow',
            action: 'agent#use',
            tenant_id: 'default',
            subject_hash: 'h',
            correlation_id: 'c',
            source: 'bff',
            pdp: 'openfga',
            resource_ref: 'user:alice can_use agent:default',
          },
        ],
        total: 1,
        page: 1,
        limit: 30,
      }),
    });

    render(<UnifiedAuditTab isAdmin />);

    expect(await screen.findByText(/agent#use/i)).toBeInTheDocument();
    expect(screen.getAllByText(/OpenFGA ReBAC/i).length).toBeGreaterThan(0);
  });

  it('blends bridge OpenFGA decisions into the audit table without rendering trace links', async () => {
    (global.fetch as jest.Mock).mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          records: [
            {
              id: '1',
              ts: new Date().toISOString(),
              type: 'openfga_rebac',
              outcome: 'allow',
              action: 'mcp#can_call',
              tenant_id: 'default',
              subject_hash: 'h',
              correlation_id: 'c',
              source: 'openfga_authz_bridge',
              component: 'agent_gateway',
              pdp: 'openfga',
              resource_ref: 'user:alice can_call mcp_gateway:list',
              trace_id: '0123456789abcdef0123456789abcdef',
            },
          ],
          total: 1,
          page: 1,
          limit: 30,
        }),
      });
    });

    render(<UnifiedAuditTab isAdmin />);

    expect(await screen.findByText(/mcp#can_call/i)).toBeInTheDocument();
    expect(screen.getByText(/openfga_authz_bridge/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/mcp#can_call/i));
    expect(screen.queryByText(/^Trace:/i)).not.toBeInTheDocument();
  });

  it('shows event type and outcome definition help', async () => {
    render(<UnifiedAuditTab isAdmin />);

    await screen.findByText(/RBAC Audit Log/i);

    const typeHelp = screen.getByRole('button', { name: /event type definitions/i });
    fireEvent.click(typeHelp);
    expect(await screen.findByText(/Grant and revoke attempts written by CAS/i)).toBeInTheDocument();
    expect(screen.getByText(/Allow\/deny results when the Centralized Authorization Service/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /outcome filter definitions/i }));
    expect(await screen.findByText(/A policy change \(grant\/revoke\) completed/i)).toBeInTheDocument();
  });

  it('renders cas_grant policy-change events with caller and grantee context', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        records: [
          {
            ts: new Date().toISOString(),
            type: 'cas_grant',
            outcome: 'success',
            action: 'use',
            tenant_id: 'acme',
            subject_hash: 'hash-caller',
            correlation_id: 'grant-corr',
            source: 'cas',
            caller_ref: 'user:alice',
            grantee_ref: 'team:eng',
            operation: 'grant',
            resource_ref: 'agent:platform-engineer',
            component: 'cas',
            pdp: 'openfga',
          },
          {
            ts: new Date().toISOString(),
            type: 'cas_grant',
            outcome: 'error',
            action: 'use',
            tenant_id: 'acme',
            subject_hash: 'hash-caller',
            correlation_id: 'grant-deny-corr',
            source: 'cas',
            caller_ref: 'user:bob',
            grantee_ref: 'team:eng',
            operation: 'revoke',
            reason_code: 'NO_CAPABILITY',
            resource_ref: 'agent:platform-engineer',
          },
        ],
        total: 2,
        page: 1,
        limit: 30,
      }),
    });

    render(<UnifiedAuditTab isAdmin />);

    expect(await screen.findByText(/user:alice/i)).toBeInTheDocument();
    expect(screen.getByText(/user:bob/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Policy change/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('option', { name: /Policy changes/i })).toBeInTheDocument();

    fireEvent.click(screen.getByText(/user:alice/i));
    expect(await screen.findByText(/Grantee:/i)).toBeInTheDocument();
    expect(screen.getByText(/team:eng/i)).toBeInTheDocument();
    expect(screen.getByText(/Operation:/i)).toBeInTheDocument();
    expect(screen.getByText(/^grant$/i)).toBeInTheDocument();
  });

  it('renders reconcile events as applied policy changes without unknown fields', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        records: [
          {
            ts: new Date('2026-08-27T21:37:47.000Z').toISOString(),
            type: 'cas_reconcile',
            outcome: 'success',
            action: 'reconcile',
            tenant_id: 'default',
            subject_ref: 'system:config-seed',
            actor_ref: 'system:config-seed',
            correlation_id: 'reconcile-correlation',
            source: 'cas',
            reconcile_scope: 'config_seed',
            requested_writes: 4,
            requested_deletes: 1,
            writes: 3,
            deletes: 1,
            component: 'cas',
            pdp: 'openfga',
            resource_ref: 'authorization_policy:openfga_relationship_tuples',
            resource_type: 'authorization_policy',
            resource_id: 'openfga_relationship_tuples',
          },
        ],
        total: 1,
        page: 1,
        limit: 30,
      }),
    });

    render(<UnifiedAuditTab isAdmin />);

    const story = await screen.findByText(/Reconciled config seed — 3 added, 1 removed/i);
    expect(screen.getByText('system:config-seed')).toBeInTheDocument();
    expect(screen.getByText(/Scope config seed · Requested 4 added, 1 removed/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Policy reconciliation/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^unknown$/i)).not.toBeInTheDocument();

    fireEvent.click(story);
    expect(await screen.findByText(/^Target:/i)).toBeInTheDocument();
    expect(screen.getByText(/^OpenFGA relationships$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Applied Additions:/i)).toBeInTheDocument();
    expect(screen.getByText(/^3$/)).toBeInTheDocument();
  });

  it('renders CAS decisions as readable authorization stories', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        records: [
          {
            ts: new Date('2026-06-11T22:05:36.000Z').toISOString(),
            type: 'cas_decision',
            outcome: 'allow',
            action: 'manage',
            tenant_id: 'default',
            subject_hash: 'sha256:9accc8a00ffe8ae4451e81d95686e1f4',
            user_email: 'sraradhy@cisco.com',
            correlation_id: 'af9c0e92-3060-46de-bb16-db3e26c4f973',
            source: 'cas',
            component: 'cas',
            pdp: 'openfga',
            reason_code: 'OK',
            resource_ref: 'organization:caipe',
            resource_type: 'organization',
            resource_id: 'caipe',
            decision_via: 'tuple',
          },
        ],
        total: 1,
        page: 1,
        limit: 30,
      }),
    });

    render(<UnifiedAuditTab isAdmin />);

    expect(await screen.findByText(/Allowed to manage organization caipe/i)).toBeInTheDocument();
    expect(screen.getByText(/sraradhy@cisco.com/i)).toBeInTheDocument();
    expect(screen.getByText(/OpenFGA tuple/i)).toBeInTheDocument();
    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent?.trim());
    expect(headers.indexOf('Actor')).toBeLessThan(headers.indexOf('Request'));

    fireEvent.click(screen.getByText(/Allowed to manage organization caipe/i));
    expect(await screen.findByText(/What happened:/i)).toBeInTheDocument();
    expect(screen.getByText(/CAS allowed this request because OpenFGA returned OK/i)).toBeInTheDocument();
  });

  it('renders canonical principal display names instead of hashes or raw refs when available', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        records: [
          {
            ts: new Date('2026-06-20T13:47:23.000Z').toISOString(),
            type: 'cas_decision',
            outcome: 'deny',
            action: 'discover',
            tenant_id: 'default',
            subject_hash: 'sha256:b66560fb57cd7d14c2ca3e9ec4220b868c94b5395120c46efaa34a1f142895f0',
            subject_ref: 'user:cc0fac46-262e-4131-9925-324f482ec403',
            actor_ref: 'user:cc0fac46-262e-4131-9925-324f482ec403',
            subject_display: 'alice@example.com',
            actor_display: 'alice@example.com',
            correlation_id: 'fa5856b3-78b7-4dc1-bd84-5fd9ac654718',
            source: 'cas',
            component: 'cas',
            pdp: 'openfga',
            reason_code: 'NO_CAPABILITY',
            resource_ref: 'conversation:adbf4d53-cdd2-493c-b613-06f7c25f4709',
            resource_type: 'conversation',
            resource_id: 'adbf4d53-cdd2-493c-b613-06f7c25f4709',
          },
        ],
        total: 1,
        page: 1,
        limit: 30,
      }),
    });

    render(<UnifiedAuditTab isAdmin />);

    expect(await screen.findByText(/alice@example.com/i)).toBeInTheDocument();
    expect(screen.queryByText(/sha256:b66560/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/user:cc0fac46/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/Denied to discover conversation/i));
    expect(await screen.findByText(/Subject:/i)).toBeInTheDocument();
    expect(screen.getAllByText(/alice@example.com/i).length).toBeGreaterThan(1);
    expect(screen.queryByText(/Subject Hash:/i)).not.toBeInTheDocument();
  });

  it('downloads all filtered audit events as a ZIP with raw JSON', async () => {
    const exportedUrls: string[] = [];
    const createObjectURL = jest.fn(() => {
      exportedUrls.push(`blob:mock-${exportedUrls.length}`);
      return exportedUrls[exportedUrls.length - 1];
    });
    const revokeObjectURL = jest.fn();
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });

    const pageOneRecord = {
      id: 'cas-1',
      ts: new Date('2026-06-11T20:00:00.000Z').toISOString(),
      type: 'cas_decision',
      outcome: 'allow',
      action: 'use',
      tenant_id: 'default',
      subject_hash: 'sha256:owner',
      correlation_id: 'wfrun-20260611200000-abc',
      source: 'cas',
      resource_ref: 'agent:hello-world',
      resource_type: 'agent',
      resource_id: 'hello-world',
      workflow_run_id: 'wfrun-20260611200000-abc',
      decision_via: 'tuple',
    };
    const pageTwoRecord = {
      ...pageOneRecord,
      id: 'cas-2',
      correlation_id: 'wfrun-20260611200000-def',
      workflow_run_id: 'wfrun-20260611200000-def',
    };

    const auditEventUrls: string[] = [];
    const auditResponses = [
      {
        ok: true,
        json: async () => ({
          records: [],
          total: 0,
          page: 1,
          limit: 30,
        }),
      },
      {
        ok: true,
        json: async () => ({
          records: [],
          total: 0,
          page: 1,
          limit: 30,
        }),
      },
      {
        ok: true,
        json: async () => ({
          records: [pageOneRecord],
          total: 2,
          page: 1,
          limit: 200,
        }),
      },
      {
        ok: true,
        json: async () => ({
          records: [pageTwoRecord],
          total: 2,
          page: 2,
          limit: 200,
        }),
      },
    ];

    (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
      if (url.includes('/api/audit/config')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            backend: 'service',
            readsAvailable: true,
            storageBackend: 's3',
            storageLabel: 'Storage: audit-service -> S3',
          }),
        });
      }
      if (url.includes('/api/admin/audit-storage')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ storage: null, retention: null, verbosity: null, errors: [] }),
        });
      }
      auditEventUrls.push(url);
      return Promise.resolve(
        auditResponses.shift() ?? {
          ok: true,
          json: async () => ({
            records: [],
            total: 0,
            page: 1,
            limit: 30,
          }),
        },
      );
    });

    render(<UnifiedAuditTab isAdmin />);

    await screen.findByText(/RBAC Audit Log/i);
    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: 'cas_decision' },
    });
    await waitFor(() => {
      expect(auditEventUrls).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: /download audit log/i }));

    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    });

    expect(auditEventUrls[2]).toContain('type=cas_decision');
    expect(auditEventUrls[2]).toContain('limit=200');
    expect(auditEventUrls[3]).toContain('page=2');
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-0');

    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const zip = await JSZip.loadAsync(blob);
    const manifestText = await zip.file('manifest.json')?.async('string');
    const recordsText = await zip.file('audit-events.json')?.async('string');
    expect(manifestText).toBeTruthy();
    expect(recordsText).toBeTruthy();

    const manifest = JSON.parse(manifestText ?? '{}');
    const records = JSON.parse(recordsText ?? '[]');
    expect(manifest).toMatchObject({
      format: 'raw-json-zip',
      filters: { type: 'cas_decision' },
      total: 2,
      record_count: 2,
    });
    expect(manifest.files).toEqual(['audit-events.json', 'manifest.json']);
    expect(records).toEqual([pageOneRecord, pageTwoRecord]);

    click.mockRestore();
  });
});
