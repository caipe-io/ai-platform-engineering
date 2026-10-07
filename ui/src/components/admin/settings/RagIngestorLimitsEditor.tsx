"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  RAG_INGESTOR_LIMIT_BOUNDS as BOUNDS,
  type RagIngestorLimits,
} from "@/lib/rag-ingestor-limits";

interface RagIngestorLimitsEditorProps {
  value: RagIngestorLimits;
  onChange: (value: RagIngestorLimits) => void;
  disabled?: boolean;
}

type SectionName = keyof RagIngestorLimits;

interface NumericSetting {
  section: SectionName;
  field: string;
  label: string;
  help: string;
  minimum: number;
  maximum: number;
  step?: number;
}

interface ToggleSetting {
  section: SectionName;
  field: string;
  label: string;
  help: string;
}

interface SettingsGroup {
  title: string;
  description: string;
  numeric: NumericSetting[];
  toggles: ToggleSetting[];
}

const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    title: "Shared",
    description: "Defaults for every datasource.",
    numeric: [
      {
        section: "shared",
        field: "max_chunk_size",
        label: "Maximum chunk size",
        help: "Largest amount of text stored in one chunk.",
        ...BOUNDS.shared.max_chunk_size!,
      },
      {
        section: "shared",
        field: "max_chunk_overlap",
        label: "Maximum chunk overlap",
        help: "Text repeated between chunks. Must be smaller than chunk size.",
        ...BOUNDS.shared.max_chunk_overlap!,
      },
      {
        section: "shared",
        field: "min_reload_interval_seconds",
        label: "Minimum refresh interval",
        help: "Shortest allowed time between automatic updates, in seconds.",
        ...BOUNDS.shared.min_reload_interval_seconds!,
      },
      {
        section: "shared",
        field: "max_reload_interval_seconds",
        label: "Maximum refresh interval",
        help: "Longest allowed time between automatic updates, in seconds.",
        ...BOUNDS.shared.max_reload_interval_seconds!,
      },
      {
        section: "shared",
        field: "max_search_teams",
        label: "Maximum Search teams",
        help: "Set to 0 to block new team access. Existing access stays unchanged.",
        ...BOUNDS.shared.max_search_teams!,
      },
    ],
    toggles: [],
  },
  {
    title: "File",
    description: "Limits for file uploads.",
    numeric: [
      {
        section: "file",
        field: "max_files_per_upload",
        label: "Files per upload",
        help: "Most files allowed in one upload.",
        ...BOUNDS.file.max_files_per_upload!,
      },
      {
        section: "file",
        field: "max_file_size_mb",
        label: "File size (MiB)",
        help: "Largest allowed file.",
        ...BOUNDS.file.max_file_size_mb!,
      },
      {
        section: "file",
        field: "max_total_upload_size_mb",
        label: "Upload size (MiB)",
        help: "Largest combined upload.",
        ...BOUNDS.file.max_total_upload_size_mb!,
      },
    ],
    toggles: [],
  },
  {
    title: "Slack",
    description: "Limits for importing channel history.",
    numeric: [
      {
        section: "slack",
        field: "max_lookback_days",
        label: "Maximum lookback days",
        help: "How far back a new source can read messages.",
        ...BOUNDS.slack.max_lookback_days!,
      },
    ],
    toggles: [
      {
        section: "slack",
        field: "allow_full_history",
        label: "Allow full channel history",
        help: "Let a source import all available messages.",
      },
      {
        section: "slack",
        field: "allow_bot_messages",
        label: "Allow bot messages",
        help: "Let sources include messages sent by bots.",
      },
    ],
  },
  {
    title: "Confluence",
    description: "Limits for pages and title filters.",
    numeric: [
      {
        section: "confluence",
        field: "max_title_patterns",
        label: "Patterns per title filter",
        help: "Most entries allowed in each include or exclude list.",
        ...BOUNDS.confluence.max_title_patterns!,
      },
    ],
    toggles: [
      {
        section: "confluence",
        field: "allow_child_pages",
        label: "Allow child pages",
        help: "Let a source include pages below its starting page.",
      },
    ],
  },
  {
    title: "Jira",
    description: "Limits for issue searches and details.",
    numeric: [
      {
        section: "jira",
        field: "max_jql_length",
        label: "Maximum JQL length",
        help: "Most characters allowed in a Jira search.",
        ...BOUNDS.jira.max_jql_length!,
      },
      {
        section: "jira",
        field: "max_custom_fields",
        label: "Maximum custom fields",
        help: "Most custom fields allowed in one source.",
        ...BOUNDS.jira.max_custom_fields!,
      },
    ],
    toggles: [
      {
        section: "jira",
        field: "allow_comments",
        label: "Allow comments",
        help: "Let sources include issue comments.",
      },
      {
        section: "jira",
        field: "allow_issue_links",
        label: "Allow issue links",
        help: "Let sources include linked issue details.",
      },
    ],
  },
  {
    title: "Web crawler",
    description: "Limits for website crawling.",
    numeric: [
      {
        section: "web",
        field: "max_depth",
        label: "Maximum crawl depth",
        help: "How many links away from the starting page a crawl can go.",
        ...BOUNDS.web.max_depth!,
      },
      {
        section: "web",
        field: "max_pages",
        label: "Maximum pages",
        help: "Most pages allowed in one crawl.",
        ...BOUNDS.web.max_pages!,
      },
      {
        section: "web",
        field: "max_page_load_timeout_seconds",
        label: "Maximum page timeout",
        help: "Longest wait for one page, in seconds.",
        ...BOUNDS.web.max_page_load_timeout_seconds!,
      },
      {
        section: "web",
        field: "min_download_delay_seconds",
        label: "Minimum request delay",
        help: "Shortest pause between requests, in seconds.",
        ...BOUNDS.web.min_download_delay_seconds!,
        step: 0.01,
      },
      {
        section: "web",
        field: "max_download_delay_seconds",
        label: "Maximum request delay",
        help: "Longest pause between requests, in seconds.",
        ...BOUNDS.web.max_download_delay_seconds!,
        step: 0.01,
      },
      {
        section: "web",
        field: "max_concurrent_requests",
        label: "Maximum concurrent requests",
        help: "Most pages fetched at the same time.",
        ...BOUNDS.web.max_concurrent_requests!,
      },
      {
        section: "web",
        field: "max_url_patterns",
        label: "Patterns per URL filter",
        help: "Most entries allowed in each include or exclude list.",
        ...BOUNDS.web.max_url_patterns!,
      },
    ],
    toggles: [
      {
        section: "web",
        field: "allow_javascript",
        label: "Allow JavaScript rendering",
        help: "Let sources load pages that need JavaScript.",
      },
      {
        section: "web",
        field: "allow_external_links",
        label: "Allow external links",
        help: "Let a crawl leave its starting website.",
      },
      {
        section: "web",
        field: "allow_ignore_robots_txt",
        label: "Allow ignoring robots.txt",
        help: "Let a source crawl pages that robots.txt excludes.",
      },
      {
        section: "web",
        field: "allow_custom_user_agent",
        label: "Allow custom user agents",
        help: "Let users change the crawler name sent to websites.",
      },
      {
        section: "web",
        field: "allow_non_public_urls",
        label: "Allow private URLs",
        help: "Let sources crawl internal network addresses.",
      },
    ],
  },
  {
    title: "Webex",
    description: "Settings for importing space messages.",
    numeric: [],
    toggles: [
      {
        section: "webex",
        field: "allow_bot_messages",
        label: "Allow bot messages",
        help: "Let sources include messages sent by bots.",
      },
    ],
  },
];

function sectionRecord(
  value: RagIngestorLimits,
  section: SectionName,
): Record<string, number | boolean> {
  return value[section] as unknown as Record<string, number | boolean>;
}

export function RagIngestorLimitsEditor({
  value,
  onChange,
  disabled = false,
}: RagIngestorLimitsEditorProps) {
  const update = (section: SectionName, field: string, next: number | boolean) => {
    onChange({
      ...value,
      [section]: {
        ...value[section],
        [field]: next,
      },
    } as RagIngestorLimits);
  };

  const fields = (group: SettingsGroup) => (
    <div className="mt-4 space-y-5">
      {group.numeric.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {group.numeric.map((setting) => {
            const id = `rag-limit-${setting.section}-${setting.field}`;
            return (
              <div key={id} className="space-y-1.5">
                <Label htmlFor={id}>{setting.label}</Label>
                <Input
                  id={id}
                  type="number"
                  min={setting.minimum}
                  max={setting.maximum}
                  step={setting.step ?? 1}
                  value={Number(sectionRecord(value, setting.section)[setting.field])}
                  disabled={disabled}
                  onChange={(event) =>
                    update(setting.section, setting.field, Number(event.target.value))
                  }
                />
                <p className="text-xs text-muted-foreground">{setting.help}</p>
              </div>
            );
          })}
        </div>
      )}

      {group.toggles.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {group.toggles.map((setting) => {
            const id = `rag-limit-${setting.section}-${setting.field}`;
            return (
              <div
                key={id}
                className="flex items-center justify-between gap-4 rounded-md bg-muted/20 p-3"
              >
                <div className="min-w-0">
                  <Label htmlFor={id}>{setting.label}</Label>
                  <p className="text-xs text-muted-foreground">{setting.help}</p>
                </div>
                <Switch
                  id={id}
                  aria-label={setting.label}
                  checked={Boolean(
                    sectionRecord(value, setting.section)[setting.field],
                  )}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    update(setting.section, setting.field, checked)
                  }
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const [shared, ...connectors] = SETTINGS_GROUPS;

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border/60 p-4">
        <h3 className="text-sm font-semibold">{shared.title}</h3>
        <p className="mt-2 text-xs text-muted-foreground">
          {shared.description}
        </p>
        {fields(shared)}
      </section>

      {connectors.map((group) => (
        <details key={group.title} className="rounded-lg border border-border/60 p-4">
          <summary className="cursor-pointer text-sm font-semibold">
            {group.title}
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">
            {group.description}
          </p>
          {fields(group)}
        </details>
      ))}
    </div>
  );
}

export default RagIngestorLimitsEditor;
