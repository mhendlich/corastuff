import { useEffect, useState } from "react";
import { Badge, Button, Divider, Group, NumberInput, Stack, Switch, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlayerPlay } from "@tabler/icons-react";
import { Panel } from "../../../components/Panel";
import text from "../../../ui/text.module.css";
import { fmtAgo, fmtTs } from "../../../lib/time";
import type { LinkCountsBySource, ScheduleDoc, SourceDoc, SourceLastScrape } from "../../../convexFns";

function SourceEnabledToggle(props: {
  slug: string;
  enabled: boolean;
  onSetEnabled: (args: { slug: string; enabled: boolean }) => Promise<unknown>;
}) {
  const [enabled, setEnabled] = useState(props.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(props.enabled);
  }, [props.enabled, props.slug]);

  return (
    <Stack gap={6} align="flex-end">
      <Switch
        checked={enabled}
        disabled={saving}
        label="Enabled"
        onChange={async (e) => {
          const next = e.currentTarget.checked;
          setEnabled(next);
          setSaving(true);
          setError(null);
          try {
            await props.onSetEnabled({ slug: props.slug, enabled: next });
          } catch (err) {
            setEnabled(props.enabled);
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setSaving(false);
          }
        }}
      />
      {error ? (
        <Text size="xs" c="red.2">
          {error}
        </Text>
      ) : null}
    </Stack>
  );
}

function ScheduleEditor(props: {
  sourceSlug: string;
  schedule: ScheduleDoc | null;
  sourceEnabled: boolean;
  onSave: (args: { sourceSlug: string; enabled: boolean; intervalMinutes: number }) => Promise<unknown>;
}) {
  const initialEnabled = props.schedule?.enabled ?? false;
  const initialInterval = props.schedule?.intervalMinutes ?? 60;

  const [enabled, setEnabled] = useState(initialEnabled);
  const [intervalMinutes, setIntervalMinutes] = useState<number>(initialInterval);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(initialEnabled);
    setIntervalMinutes(initialInterval);
  }, [initialEnabled, initialInterval, props.sourceSlug]);

  const dirty = enabled !== initialEnabled || intervalMinutes !== initialInterval;
  const intervalOk = Number.isFinite(intervalMinutes) && intervalMinutes > 0;

  const nextLabel =
    props.schedule?.enabled && typeof props.schedule?.nextRunAt === "number" ? fmtTs(props.schedule.nextRunAt) : null;

  return (
    <Stack gap={6} align="flex-end">
      <Group gap="sm" wrap="nowrap">
        <Switch
          checked={enabled}
          disabled={!props.sourceEnabled}
          label="Schedule"
          onChange={(e) => setEnabled(e.currentTarget.checked)}
        />
        <NumberInput
          value={intervalMinutes}
          onChange={(v) => setIntervalMinutes(typeof v === "number" ? v : initialInterval)}
          min={1}
          step={1}
          allowDecimal={false}
          thousandSeparator={false}
          suffix=" min"
          w={140}
          disabled={!props.sourceEnabled || !enabled}
        />
        <Button
          size="xs"
          variant="light"
          disabled={!props.sourceEnabled || !dirty || saving || !intervalOk}
          loading={saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await props.onSave({ sourceSlug: props.sourceSlug, enabled, intervalMinutes });
              notifications.show({ title: "Saved", message: `${props.sourceSlug} schedule updated` });
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setSaving(false);
            }
          }}
        >
          Save
        </Button>
      </Group>
      {nextLabel ? (
        <Text size="xs" c="dimmed">
          Next run {nextLabel}
        </Text>
      ) : null}
      {!props.sourceEnabled ? (
        <Text size="xs" c="dimmed">
          Enable source to schedule runs
        </Text>
      ) : null}
      {error ? (
        <Text size="xs" c="red.2">
          {error}
        </Text>
      ) : null}
    </Stack>
  );
}

export function SourceCard(props: {
  source: SourceDoc;
  counts: LinkCountsBySource | null;
  lastScrape: SourceLastScrape | null;
  schedule: ScheduleDoc | null;
  activeRun: { runId: string; status: string } | null;
  onEnable: (args: { slug: string; enabled: boolean }) => Promise<unknown>;
  onSaveSchedule: (args: { sourceSlug: string; enabled: boolean; intervalMinutes: number }) => Promise<unknown>;
  onRun: () => Promise<void>;
  runLoading: boolean;
  runError: string | null;
}) {
  const { source } = props;
  const counts = props.counts;
  const last = props.lastScrape;

  const enabledTone = source.enabled ? "teal" : "gray";

  return (
    <Panel>
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="lg">
        <Stack gap={6} style={{ minWidth: 0 }}>
          <Group gap="sm" wrap="wrap">
            <Text fw={750} size="sm" lineClamp={1} title={source.displayName}>
              {source.displayName}
            </Text>
            <Badge variant="light" color={enabledTone} radius="xl">
              {source.enabled ? "enabled" : "disabled"}
            </Badge>
            <Badge variant="light" color="gray" radius="xl">
              {source.type}
            </Badge>
            {props.activeRun ? (
              <Badge variant="light" color="cyan" radius="xl">
                active
              </Badge>
            ) : null}
          </Group>

          <Group gap="md" wrap="wrap">
            <Text size="xs" c="dimmed">
              slug <span className={text.mono}>{source.slug}</span>
            </Text>
            <Text size="xs" c="dimmed">
              last success {source.lastSuccessfulAt ? fmtAgo(source.lastSuccessfulAt) : "—"}
            </Text>
            {last?.lastRunAt ? (
              <Text size="xs" c="dimmed">
                last run {fmtAgo(last.lastRunAt)} {last.lastRunStatus ? `(${last.lastRunStatus})` : ""}
              </Text>
            ) : null}
          </Group>

          {counts ? (
            <Group gap="md" wrap="wrap">
              <Text size="xs" c="dimmed">
                linked <span className={text.mono}>{counts.linked}</span>
              </Text>
              <Text size="xs" c="dimmed">
                unlinked <span className={text.mono}>{counts.unlinked}</span>
              </Text>
              <Text size="xs" c="dimmed">
                total <span className={text.mono}>{counts.totalProducts}</span>
              </Text>
              {counts.truncated ? (
                <Badge variant="light" color="yellow" radius="xl">
                  truncated
                </Badge>
              ) : null}
            </Group>
          ) : (
            <Text size="xs" c="dimmed">
              Product stats unavailable
            </Text>
          )}

          {props.runError ? (
            <Text size="xs" c="red.2">
              run error: {props.runError}
            </Text>
          ) : null}
        </Stack>

        <Stack gap="sm" align="flex-end">
          <SourceEnabledToggle slug={source.slug} enabled={source.enabled} onSetEnabled={props.onEnable} />
          <Button
            leftSection={<IconPlayerPlay size={16} />}
            variant="light"
            loading={props.runLoading}
            disabled={!source.enabled || props.runLoading}
            onClick={() => void props.onRun()}
          >
            Run now
          </Button>
        </Stack>
      </Group>

      <Divider my="md" />

      <ScheduleEditor
        sourceSlug={source.slug}
        schedule={props.schedule}
        sourceEnabled={source.enabled}
        onSave={props.onSaveSchedule}
      />
    </Panel>
  );
}

