import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Button,
  Container,
  Group,
  JsonInput,
  Loader,
  Select,
  Stack,
  Switch,
  Text,
  TextInput
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { IconChevronLeft, IconTestPipe } from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import type { SourceType } from "@corastuff/shared";
import { sourcesGetBySlug, sourcesStartDryRun, sourcesUpsert, type SourceDoc } from "../convexFns";
import { configToJsonString, parseConfigJsonObject } from "../features/sources/configJson";
import classes from "./SourceEditorPage.module.css";

export function SourceEditPage(props: { sessionToken: string }) {
  const navigate = useNavigate();
  const params = useParams();
  const { sessionToken } = props;
  const slug = typeof params.slug === "string" ? params.slug : "";

  const source: SourceDoc | null | undefined = useQuery(sourcesGetBySlug, { sessionToken, slug });
  const upsert = useMutation(sourcesUpsert);
  const startDryRun = useAction(sourcesStartDryRun);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const initial = useMemo(() => {
    if (!source) return null;
    return {
      slug: source.slug,
      displayName: source.displayName,
      enabled: source.enabled,
      type: source.type,
      configJson: configToJsonString(source.config)
    };
  }, [source]);

  const form = useForm({
    initialValues: {
      slug,
      displayName: "",
      enabled: false,
      type: "http" as SourceType,
      configJson: configToJsonString({})
    },
    validate: {
      displayName: (value) => (value.trim() ? null : "Display name is required"),
      configJson: (value) => parseConfigJsonObject(value).error
    }
  });

  useEffect(() => {
    if (!initial) return;
    if (hydrated) return;
    form.setValues(initial);
    setHydrated(true);
  }, [form, hydrated, initial]);

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
      notifications.show({ title: "Saved", message: "Source updated." });
      return { slug: form.values.slug.trim(), config: parsed.value };
    } catch (err) {
      notifications.show({
        title: "Save failed",
        message: err instanceof Error ? err.message : String(err),
        color: "red"
      });
      return null;
    } finally {
      setSaving(false);
    }
  };

  const testDryRun = async (configOverride?: Record<string, unknown>) => {
    setTesting(true);
    try {
      const started = await startDryRun({ sessionToken, sourceSlug: form.values.slug.trim(), configOverride });
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

  const saveAndTest = async () => {
    const result = await save();
    if (!result) return;
    await testDryRun(result.config);
  };

  const testWithoutSave = async () => {
    const parsed = parseConfigJsonObject(form.values.configJson);
    if (parsed.error || !parsed.value) {
      form.setFieldError("configJson", parsed.error ?? "Invalid config");
      return;
    }
    await testDryRun(parsed.value);
  };

  if (source === undefined) {
    return (
      <Container size="md" py="xl">
        <Group gap="sm">
          <Loader size="sm" />
          <Text c="dimmed">Loading source…</Text>
        </Group>
      </Container>
    );
  }

  if (source === null) {
    return (
      <Container size="md" py="xl">
        <Stack gap="sm">
          <Text fw={600}>Source not found</Text>
          <Text size="sm" c="dimmed">
            Unknown slug: <code>{slug}</code>
          </Text>
          <Button variant="default" leftSection={<IconChevronLeft size={16} />} onClick={() => navigate("/scrapers/sources")}>
            Back
          </Button>
        </Stack>
      </Container>
    );
  }

  return (
    <Container size="xl" py="xl">
      <form onSubmit={form.onSubmit(() => void save())}>
        <Stack gap="lg">
          <PageHeader
            title={`Edit source: ${source.slug}`}
            subtitle="Update config and validate with a dry-run test."
            right={
              <Group gap="sm">
                <Button variant="default" type="button" leftSection={<IconChevronLeft size={16} />} onClick={() => navigate("/scrapers/sources")}>
                  Back
                </Button>
                <Button
                  variant="default"
                  type="button"
                  leftSection={<IconTestPipe size={16} />}
                  loading={testing}
                  disabled={saving}
                  onClick={() => void testWithoutSave()}
                >
                  Test
                </Button>
                <Button
                  variant="default"
                  type="button"
                  leftSection={<IconTestPipe size={16} />}
                  loading={testing}
                  disabled={saving}
                  onClick={() => void saveAndTest()}
                >
                  Save & test
                </Button>
                <Button type="submit" loading={saving} disabled={testing}>
                  Save
                </Button>
              </Group>
            }
          />

          <div className={classes.split}>
            <Panel>
              <Stack gap="md">
                <TextInput label="Slug" disabled value={source.slug} description="Immutable ID." />
                <TextInput
                  label="Display name"
                  required
                  placeholder="e.g. Cardiofitness (Shopify)"
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
                  description="Disabling also disables its schedule."
                  checked={form.values.enabled}
                  onChange={(e) => form.setFieldValue("enabled", e.currentTarget.checked)}
                />
              </Stack>
            </Panel>

            <Panel>
              <Stack gap="sm">
                <Group justify="space-between" align="flex-end">
                  <Text fw={600}>Config JSON</Text>
                  <Button variant="subtle" color="gray" size="xs" type="button" onClick={formatConfig}>
                    Format
                  </Button>
                </Group>
                <JsonInput
                  className={classes.configInput}
                  required
                  minRows={20}
                  autosize
                  validationError="Invalid JSON"
                  formatOnBlur
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
