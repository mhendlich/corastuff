import { useAction, useMutation } from "convex/react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Container,
  Group,
  JsonInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { IconPlayerPlay, IconPlus, IconTestPipe } from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import type { SourceType } from "@corastuff/shared";
import { sourcesStartDryRun, sourcesUpsert } from "../convexFns";
import { configToJsonString, parseConfigJsonObject, slugError } from "../features/sources/configJson";
import classes from "./SourceEditorPage.module.css";

export function SourceCreatePage(props: { sessionToken: string }) {
  const navigate = useNavigate();
  const { sessionToken } = props;

  const upsert = useMutation(sourcesUpsert);
  const startDryRun = useAction(sourcesStartDryRun);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const form = useForm({
    initialValues: {
      slug: "",
      displayName: "",
      enabled: false,
      type: "http" as SourceType,
      configJson: configToJsonString({})
    },
    validate: {
      slug: (value) => slugError(value),
      displayName: (value) => (value.trim() ? null : "Display name is required"),
      configJson: (value) => parseConfigJsonObject(value).error
    }
  });

  const formatConfig = () => {
    const parsed = parseConfigJsonObject(form.values.configJson);
    if (parsed.error || !parsed.value) {
      notifications.show({ title: "Invalid JSON", message: parsed.error ?? "Invalid config", color: "red" });
      return;
    }
    form.setFieldValue("configJson", configToJsonString(parsed.value));
  };

  const save = async () => {
    const parsed = parseConfigJsonObject(form.values.configJson);
    if (parsed.error || !parsed.value) {
      form.setFieldError("configJson", parsed.error ?? "Invalid config");
      return null;
    }

    setSaving(true);
    try {
      await upsert({
        sessionToken,
        slug: form.values.slug.trim(),
        displayName: form.values.displayName.trim(),
        enabled: form.values.enabled,
        type: form.values.type,
        config: parsed.value
      });
      notifications.show({ title: "Saved", message: "Source created." });
      return { slug: form.values.slug.trim(), config: parsed.value };
    } catch (err) {
      notifications.show({
        title: "Create failed",
        message: err instanceof Error ? err.message : String(err),
        color: "red"
      });
      return null;
    } finally {
      setSaving(false);
    }
  };

  const createOnly = async () => {
    const result = await save();
    if (result) navigate(`/scrapers/sources/${result.slug}`);
  };

  const createAndTest = async () => {
    const result = await save();
    if (!result) return;

    setTesting(true);
    try {
      const started = await startDryRun({ sessionToken, sourceSlug: result.slug, configOverride: result.config });
      notifications.show({ title: "Test started", message: "Dry-run enqueued. Opening run detail…" });
      navigate(`/scrapers/history/${started.runId}`);
    } catch (err) {
      notifications.show({
        title: "Test failed",
        message: err instanceof Error ? err.message : String(err),
        color: "red"
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Container size="xl" py="xl">
      <form onSubmit={form.onSubmit(() => void createOnly())}>
        <Stack gap="lg">
          <PageHeader
            title="New source"
            subtitle="Create a new source and validate with a dry-run test."
            right={
              <Group gap="sm">
                <Button variant="default" type="button" onClick={() => navigate("/scrapers/sources")}>
                  Cancel
                </Button>
                <Button
                  variant="default"
                  type="button"
                  leftSection={<IconTestPipe size={16} />}
                  loading={testing}
                  disabled={saving}
                  onClick={() => void createAndTest()}
                >
                  Create & test
                </Button>
                <Button type="submit" leftSection={<IconPlus size={16} />} loading={saving} disabled={testing}>
                  Create
                </Button>
              </Group>
            }
          />

          <div className={classes.split}>
            <Panel>
              <Stack gap="md">
                <TextInput
                  label="Slug"
                  description="Immutable ID used by schedules and run history."
                  placeholder="e.g. cardiofitness"
                  required
                  autoFocus
                  {...form.getInputProps("slug")}
                />
                <TextInput
                  label="Display name"
                  placeholder="e.g. Cardiofitness (Shopify)"
                  required
                  {...form.getInputProps("displayName")}
                />
                <Select
                  label="Type"
                  data={[
                    { value: "http", label: "http (no browser)" },
                    { value: "playwright", label: "playwright (browser)" },
                    { value: "hybrid", label: "hybrid" }
                  ]}
                  {...form.getInputProps("type")}
                />
                <Switch
                  label="Enabled"
                  description="Disabled sources cannot be run by automation."
                  checked={form.values.enabled}
                  onChange={(e) => form.setFieldValue("enabled", e.currentTarget.checked)}
                />
                <Text size="xs" c="dimmed">
                  Tip: You can also build a config via the Scraper Builder, then copy it here.
                </Text>
              </Stack>
            </Panel>

            <Panel>
              <Stack gap="sm">
                <Group justify="space-between" align="flex-end">
                  <Text fw={600}>Config JSON</Text>
                  <Group gap="sm">
                    <Button variant="subtle" color="gray" size="xs" type="button" onClick={formatConfig}>
                      Format
                    </Button>
                    <Button
                      variant="subtle"
                      color="gray"
                      size="xs"
                      type="button"
                      leftSection={<IconPlayerPlay size={14} />}
                      onClick={() => navigate("/builder")}
                    >
                      Open builder
                    </Button>
                  </Group>
                </Group>
                <JsonInput
                  className={classes.configInput}
                  required
                  minRows={20}
                  autosize
                  validationError="Invalid JSON"
                  formatOnBlur
                  placeholder='{\n  "baseUrl": "https://…"\n}'
                  {...form.getInputProps("configJson")}
                />
              </Stack>
            </Panel>
          </div>
        </Stack>
      </form>
    </Container>
  );
}
