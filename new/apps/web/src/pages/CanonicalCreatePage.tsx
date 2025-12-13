import { useMutation } from "convex/react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Container, Group, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { canonicalsCreate } from "../convexFns";
import classes from "./CanonicalFormPage.module.css";

export function CanonicalCreatePage(props: { sessionToken: string }) {
  const navigate = useNavigate();
  const create = useMutation(canonicalsCreate);

  const [saving, setSaving] = useState(false);

  const form = useForm({
    initialValues: { name: "", description: "" },
    validate: {
      name: (value) => (value.trim() ? null : "Name is required")
    }
  });

  const onSave = async (values: { name: string; description: string }) => {
    setSaving(true);
    try {
      const result = await create({
        sessionToken: props.sessionToken,
        name: values.name.trim(),
        description: values.description.trim() ? values.description.trim() : undefined
      });
      notifications.show({ title: "Created", message: "Canonical created." });
      navigate(`/products/${result.id}`);
    } catch (err) {
      notifications.show({
        title: "Create failed",
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
            title="New product"
            subtitle="Create a canonical product."
            right={
              <Group gap="sm">
                <Button variant="default" type="button" onClick={() => navigate("/products")}>
                  Cancel
                </Button>
                <Button type="submit" loading={saving}>
                  Create
                </Button>
              </Group>
            }
          />

          <Panel>
            <Stack gap="md" className={classes.formRow}>
              <TextInput
                label="Name"
                placeholder="e.g. Blackroll Standard"
                required
                autoFocus
                {...form.getInputProps("name")}
              />
              <Textarea
                label="Description"
                placeholder="Optional details to help with search and linking…"
                minRows={3}
                autosize
                {...form.getInputProps("description")}
              />
              <Text size="xs" c="dimmed">
                Tip: You can also create a canonical directly from the Link Products workbench.
              </Text>
            </Stack>
          </Panel>
        </Stack>
      </form>
    </Container>
  );
}
