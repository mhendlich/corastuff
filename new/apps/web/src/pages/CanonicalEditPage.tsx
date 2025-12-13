import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Container, Group, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { canonicalsGet, canonicalsUpdate } from "../convexFns";
import classes from "./CanonicalFormPage.module.css";

export function CanonicalEditPage(props: { sessionToken: string }) {
  const navigate = useNavigate();
  const params = useParams();
  const canonicalId = params.canonicalId ?? "";

  const canonical = useQuery(
    canonicalsGet,
    canonicalId ? { sessionToken: props.sessionToken, canonicalId } : "skip"
  );
  const update = useMutation(canonicalsUpdate);

  const [saving, setSaving] = useState(false);

  const form = useForm({
    initialValues: { name: "", description: "" },
    validate: {
      name: (value) => (value.trim() ? null : "Name is required")
    }
  });

  useEffect(() => {
    if (!canonical) return;
    form.setValues({ name: canonical.name ?? "", description: canonical.description ?? "" });
  }, [canonical?._id]);

  useEffect(() => {
    form.resetDirty();
  }, [canonical?._id]);

  if (!canonicalId) {
    return (
      <Container size="md" py="xl">
        <Text c="dimmed">Missing canonical id.</Text>
      </Container>
    );
  }

  if (canonical === undefined) {
    return (
      <Container size="md" py="xl">
        <Text c="dimmed">Loading…</Text>
      </Container>
    );
  }

  if (canonical === null) {
    return (
      <Container size="md" py="xl">
        <Text c="dimmed">Canonical not found.</Text>
      </Container>
    );
  }

  const onSave = async (values: { name: string; description: string }) => {
    setSaving(true);
    try {
      await update({
        sessionToken: props.sessionToken,
        canonicalId,
        name: values.name.trim(),
        description: values.description.trim() ? values.description.trim() : undefined
      });
      notifications.show({ title: "Saved", message: "Canonical updated." });
      navigate(`/products/${canonicalId}`);
    } catch (err) {
      notifications.show({
        title: "Save failed",
        message: err instanceof Error ? err.message : String(err),
        color: "red"
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Container size="md" py="xl">
      <form onSubmit={form.onSubmit((values) => void onSave(values))}>
        <Stack gap="lg">
          <PageHeader
            title="Edit product"
            subtitle="Update canonical name and description."
            right={
              <Group gap="sm">
                <Button variant="default" type="button" onClick={() => navigate(`/products/${canonicalId}`)}>
                  Cancel
                </Button>
                <Button type="submit" loading={saving} disabled={!form.isDirty()}>
                  Save
                </Button>
              </Group>
            }
          />

          <Panel>
            <Stack gap="md" className={classes.formRow}>
              <TextInput label="Name" required {...form.getInputProps("name")} />
              <Textarea label="Description" minRows={3} autosize {...form.getInputProps("description")} />
            </Stack>
          </Panel>
        </Stack>
      </form>
    </Container>
  );
}
