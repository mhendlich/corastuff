import { useMutation, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  Stack,
  Table,
  Text,
  Title,
  Tooltip
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconEdit, IconTrash, IconUnlink } from "@tabler/icons-react";
import { NotesEditor } from "../components/NotesEditor";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import text from "../ui/text.module.css";
import { canonicalsDetail, canonicalsRemove, linksUnlink, type CanonicalDetail } from "../convexFns";
import { fmtTs } from "../lib/time";
import classes from "./CanonicalDetailPage.module.css";

function fmtMoney(price: number | null, currency: string | null) {
  if (typeof price !== "number") return "—";
  return `${price.toFixed(2)} ${currency ?? ""}`.trim();
}

export function CanonicalDetailPage(props: { sessionToken: string }) {
  const navigate = useNavigate();
  const params = useParams();
  const canonicalId = params.canonicalId ?? "";

  const detail: CanonicalDetail | undefined = useQuery(
    canonicalsDetail,
    canonicalId ? { sessionToken: props.sessionToken, canonicalId } : "skip"
  );

  const unlink = useMutation(linksUnlink);
  const remove = useMutation(canonicalsRemove);

  const [deleting, setDeleting] = useState(false);

  const rows = useMemo(() => {
    if (!detail) return null;
    return detail.linkedProducts.map((p) => {
      const key = `${p.sourceSlug}:${p.itemId}`;
      const best = detail.bestKey === key;
      return (
        <Table.Tr key={key} className={best ? classes.bestRow : undefined}>
          <Table.Td>
            <Group gap={8} wrap="wrap">
              <Text fw={700}>{p.sourceDisplayName}</Text>
              {best ? (
                <Badge variant="light" color="violet">
                  best
                </Badge>
              ) : null}
              {!p.seenInLatestRun ? (
                <Badge variant="light" color="yellow">
                  stale
                </Badge>
              ) : null}
            </Group>
          </Table.Td>
          <Table.Td style={{ minWidth: 260 }}>
            <Text lineClamp={2}>{p.name ?? "—"}</Text>
          </Table.Td>
          <Table.Td ta="right" className={text.mono}>
            {fmtMoney(p.price, p.currency)}
          </Table.Td>
          <Table.Td className={text.mono}>{p.itemId}</Table.Td>
          <Table.Td>
            {p.url ? (
              <Anchor href={p.url} target="_blank" rel="noreferrer" className={classes.mutedLink}>
                open
              </Anchor>
            ) : (
              <Text c="dimmed" size="sm">
                —
              </Text>
            )}
          </Table.Td>
          <Table.Td ta="right">
            <Tooltip label="Unlink" withArrow>
              <ActionIcon
                variant="default"
                color="red"
                onClick={() => {
                  modals.openConfirmModal({
                    title: "Unlink product?",
                    centered: true,
                    labels: { confirm: "Unlink", cancel: "Cancel" },
                    confirmProps: { color: "red" },
                    children: (
                      <Stack gap={6}>
                        <Text size="sm">
                          Remove the link between <Text component="span" className={text.mono} inherit>{p.itemId}</Text> and this canonical?
                        </Text>
                        <Text size="xs" c="dimmed">
                          The source product remains unchanged.
                        </Text>
                      </Stack>
                    ),
                    onConfirm: async () => {
                      try {
                        await unlink({ sessionToken: props.sessionToken, sourceSlug: p.sourceSlug, itemId: p.itemId });
                        notifications.show({ title: "Unlinked", message: "Removed link." });
                      } catch (err) {
                        notifications.show({
                          title: "Unlink failed",
                          message: err instanceof Error ? err.message : String(err),
                          color: "red"
                        });
                      }
                    }
                  });
                }}
                aria-label="Unlink"
              >
                <IconUnlink size={16} />
              </ActionIcon>
            </Tooltip>
          </Table.Td>
        </Table.Tr>
      );
    });
  }, [detail, props.sessionToken, unlink]);

  if (!canonicalId) {
    return (
      <Container size="md" py="xl">
        <Text c="dimmed">Missing canonical id.</Text>
      </Container>
    );
  }

  if (detail === undefined) {
    return (
      <Container size="md" py="xl">
        <Text c="dimmed">Loading…</Text>
      </Container>
    );
  }

  if (detail === null) {
    return (
      <Container size="md" py="xl">
        <Text c="dimmed">Canonical not found.</Text>
      </Container>
    );
  }

  const canonical = detail.canonical;

  const onDelete = async () => {
    setDeleting(true);
    try {
      const result = await remove({ sessionToken: props.sessionToken, canonicalId });
      notifications.show({ title: "Deleted", message: `Deleted canonical and ${result.deletedLinks} link(s).` });
      navigate("/products");
    } catch (err) {
      notifications.show({
        title: "Delete failed",
        message: err instanceof Error ? err.message : String(err),
        color: "red"
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <PageHeader
          title={canonical.name}
          subtitle={canonical.description ? canonical.description : `Created ${fmtTs(canonical.createdAt)}`}
          right={
            <Group gap="sm">
              <Button
                variant="default"
                leftSection={<IconEdit size={16} />}
                onClick={() => navigate(`/products/${canonicalId}/edit`)}
              >
                Edit
              </Button>
              <Button
                color="red"
                variant="light"
                leftSection={<IconTrash size={16} />}
                disabled={deleting}
                onClick={() => {
                  modals.openConfirmModal({
                    title: "Delete canonical?",
                    centered: true,
                    closeOnConfirm: true,
                    labels: { confirm: "Delete", cancel: "Cancel" },
                    confirmProps: { color: "red" },
                    children: (
                      <Text size="sm">
                        This deletes the canonical and all its links. Source products remain unchanged.
                      </Text>
                    ),
                    onConfirm: () => void onDelete()
                  });
                }}
              >
                Delete
              </Button>
            </Group>
          }
        />

        <Panel>
          <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
            <div>
              <Title order={4}>Linked products</Title>
              <Text c="dimmed" size="sm">
                {detail.linkCount} link(s)
              </Text>
            </div>
          </Group>

          <div style={{ overflowX: "auto", marginTop: 16 }}>
            <Table withTableBorder highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Source</Table.Th>
                  <Table.Th>Name</Table.Th>
                  <Table.Th ta="right">Price</Table.Th>
                  <Table.Th>Item ID</Table.Th>
                  <Table.Th>URL</Table.Th>
                  <Table.Th ta="right">Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows && rows.length > 0 ? (
                  rows
                ) : (
                  <Table.Tr>
                    <Table.Td colSpan={6}>
                      <Text c="dimmed" size="sm">
                        No linked products yet. Use the Link Products page to add links.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </div>
        </Panel>

        <Panel>
          <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
            <div>
              <Title order={4}>Notes</Title>
              <Text c="dimmed" size="sm">
                Private scratchpad for this canonical (local only)
              </Text>
            </div>
          </Group>
          <div style={{ marginTop: 16 }}>
            <NotesEditor
              key={canonicalId}
              storageKey={`corastuff:canonical-notes:${canonicalId}`}
              placeholder="Add linking hints, vendor quirks, internal comments…"
            />
          </div>
        </Panel>
      </Stack>
    </Container>
  );
}
