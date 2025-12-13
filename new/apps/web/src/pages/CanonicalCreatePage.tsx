import { useMutation } from "convex/react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Container, Group, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { canonicalsCreate } from "../convexFns";
import classes from "./CanonicalFormPage.module.css";

export function CanonicalCreatePage(props: { sessionToken: string }) {
  const navigate = useNavigate();
  const create = useMutation(canonicalsCreate);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const onSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      notifications.show({ title: "Name required", message: "Enter a canonical name.", color: "red" });
      return;
    }

    setSaving(true);
    try {
      const result = await create({
        sessionToken: props.sessionToken,
        name: trimmedName,
        description: description.trim() ? description.trim() : undefined
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
      <Stack gap="lg">
        <PageHeader
          title="New product"
          subtitle="Create a canonical product."
          right={
            <Group gap="sm">
              <Button variant="default" onClick={() => navigate("/products")}>
                Cancel
              </Button>
              <Button loading={saving} onClick={() => void onSave()}>
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
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <Textarea
              label="Description"
              placeholder="Optional details to help with search and linking…"
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              minRows={3}
            />
            <Text size="xs" c="dimmed">
              Tip: You can also create a canonical directly from the Link Products workbench.
            </Text>
          </Stack>
        </Panel>
      </Stack>
    </Container>
  );
}

