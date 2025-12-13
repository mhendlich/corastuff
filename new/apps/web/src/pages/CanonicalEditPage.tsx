import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Container, Group, Stack, Text, Textarea, TextInput } from "@mantine/core";
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

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!canonical) return;
    setName(canonical.name ?? "");
    setDescription(canonical.description ?? "");
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

  const onSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      notifications.show({ title: "Name required", message: "Enter a canonical name.", color: "red" });
      return;
    }

    setSaving(true);
    try {
      await update({
        sessionToken: props.sessionToken,
        canonicalId,
        name: trimmedName,
        description: description.trim() ? description.trim() : undefined
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
      <Stack gap="lg">
        <PageHeader
          title="Edit product"
          subtitle="Update canonical name and description."
          right={
            <Group gap="sm">
              <Button variant="default" onClick={() => navigate(`/products/${canonicalId}`)}>
                Cancel
              </Button>
              <Button loading={saving} onClick={() => void onSave()}>
                Save
              </Button>
            </Group>
          }
        />

        <Panel>
          <Stack gap="md" className={classes.formRow}>
            <TextInput label="Name" required value={name} onChange={(e) => setName(e.currentTarget.value)} />
            <Textarea
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              minRows={3}
            />
          </Stack>
        </Panel>
      </Stack>
    </Container>
  );
}
