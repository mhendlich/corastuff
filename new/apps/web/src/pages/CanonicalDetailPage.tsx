import { useMutation, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Container,
  Group,
  Stack,
  Table,
  Text,
  Select,
  TextInput,
  Title,
  Tooltip
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconArrowRight, IconEdit, IconExternalLink, IconSearch, IconTrash, IconUnlink } from "@tabler/icons-react";
import { NotesEditor } from "../components/NotesEditor";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { InlineError } from "../components/InlineError";
import { fuseFilter, makeFuse } from "../lib/fuzzy";
import { notifyError, notifySuccess } from "../lib/notify";
import text from "../ui/text.module.css";
import {
  canonicalsDetail,
  canonicalsList,
  canonicalsRemove,
  linksBulkLink,
  linksBulkUnlink,
  linksUnlink,
  type CanonicalDetail,
  type CanonicalDoc
} from "../convexFns";
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
  const bulkUnlink = useMutation(linksBulkUnlink);
  const bulkLink = useMutation(linksBulkLink);
  const remove = useMutation(canonicalsRemove);

  const [deleting, setDeleting] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const [moveQuery, setMoveQuery] = useState("");
  const [moveCanonicalId, setMoveCanonicalId] = useState<string | null>(null);

  const canonicals: CanonicalDoc[] = useQuery(canonicalsList, { sessionToken: props.sessionToken, limit: 250 }) ?? [];

  const rows = useMemo(() => {
    if (!detail) return null;
    return detail.linkedProducts.map((p) => {
      const key = `${p.sourceSlug}:${p.itemId}`;
      const best = detail.bestKey === key;
      return (
        <Table.Tr key={key} className={best ? classes.bestRow : undefined}>
          <Table.Td w={44}>
            <Checkbox
              checked={selectedKeys.has(key)}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                setSelectedKeys((prev) => {
                  const next = new Set(prev);
                  if (checked) next.add(key);
                  else next.delete(key);
                  return next;
                });
              }}
              aria-label={`Select ${key}`}
            />
          </Table.Td>
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
                        notifySuccess({ title: "Unlinked", message: "Removed link." });
                      } catch (err) {
                        notifyError({ title: "Unlink failed", error: err });
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
  }, [detail, props.sessionToken, selectedKeys, unlink]);

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
      notifySuccess({ title: "Deleted", message: `Deleted canonical and ${result.deletedLinks} link(s).` });
      navigate("/products");
    } catch (err) {
      notifyError({ title: "Delete failed", error: err });
    } finally {
      setDeleting(false);
    }
  };

  const selectedItems = useMemo(() => {
    const out: Array<{ sourceSlug: string; itemId: string; url?: string | null }> = [];
    if (!detail) return out;
    for (const p of detail.linkedProducts) {
      const key = `${p.sourceSlug}:${p.itemId}`;
      if (!selectedKeys.has(key)) continue;
      out.push({ sourceSlug: p.sourceSlug, itemId: p.itemId, url: p.url ?? null });
    }
    return out;
  }, [detail, selectedKeys]);

  const allSelected = !!detail && detail.linkedProducts.length > 0 && selectedKeys.size === detail.linkedProducts.length;
  const someSelected = selectedKeys.size > 0 && !allSelected;

  const moveOptions = useMemo(() => {
    const base = canonicals.filter((c) => c._id !== canonicalId);
    const fuse = makeFuse(base, { keys: ["name", "description", "_id"] });
    const fuzzy = fuseFilter(base, fuse, moveQuery, 50);
    if (!moveCanonicalId) return fuzzy;
    const selected = base.find((c) => c._id === moveCanonicalId);
    if (!selected) return fuzzy;
    if (fuzzy.some((c) => c._id === selected._id)) return fuzzy;
    return [selected, ...fuzzy];
  }, [canonicals, canonicalId, moveCanonicalId, moveQuery]);

  const runBulkUnlink = async () => {
    if (bulkBusy) return;
    if (selectedItems.length === 0) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const result = await bulkUnlink({
        sessionToken: props.sessionToken,
        items: selectedItems.map((it) => ({ sourceSlug: it.sourceSlug, itemId: it.itemId }))
      });
      notifySuccess({
        title: "Unlinked",
        message: `${result.deleted} removed${result.missing ? ` · ${result.missing} missing` : ""}`
      });
      setSelectedKeys(new Set());
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : String(err));
      notifyError({ title: "Bulk unlink failed", error: err });
    } finally {
      setBulkBusy(false);
    }
  };

  const runBulkMove = async () => {
    if (bulkBusy) return;
    if (!moveCanonicalId) return;
    if (selectedItems.length === 0) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const result = await bulkLink({
        sessionToken: props.sessionToken,
        canonicalId: moveCanonicalId,
        items: selectedItems.map((it) => ({ sourceSlug: it.sourceSlug, itemId: it.itemId }))
      });
      notifySuccess({
        title: "Moved links",
        message: `${result.created + result.changed + result.unchanged} processed${result.missing ? ` · ${result.missing} missing` : ""}`
      });
      setSelectedKeys(new Set());
      setMoveCanonicalId(null);
      setMoveQuery("");
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : String(err));
      notifyError({ title: "Bulk move failed", error: err });
    } finally {
      setBulkBusy(false);
    }
  };

  const openSelectedUrls = () => {
    const urls = selectedItems.map((it) => it.url).filter((u): u is string => typeof u === "string" && u.trim().length > 0);
    if (urls.length === 0) {
      notifications.show({ title: "No URLs", message: "Selected rows have no URL.", color: "yellow" });
      return;
    }
    const doOpen = () => {
      for (const url of urls.slice(0, 30)) window.open(url, "_blank", "noopener,noreferrer");
      if (urls.length > 30) {
        notifications.show({ title: "Limited", message: `Opened 30 tabs (of ${urls.length}).`, color: "yellow" });
      }
    };
    if (urls.length <= 8) {
      doOpen();
      return;
    }
    modals.openConfirmModal({
      title: `Open ${urls.length} tabs?`,
      centered: true,
      labels: { confirm: "Open tabs", cancel: "Cancel" },
      children: <Text size="sm">This may be blocked by your browser if popups are restricted.</Text>,
      onConfirm: doOpen
    });
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

          {selectedKeys.size > 0 ? (
            <Stack gap="sm" mt="md">
              {bulkError ? <InlineError title="Bulk action failed" error={bulkError} onRetry={runBulkUnlink} /> : null}
              <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
                <Text size="sm" c="dimmed">
                  {selectedKeys.size} selected
                </Text>
                <Group gap="sm" wrap="wrap">
                  <Button
                    size="sm"
                    variant="default"
                    leftSection={<IconExternalLink size={16} />}
                    onClick={openSelectedUrls}
                    disabled={bulkBusy}
                  >
                    Open URLs
                  </Button>
                  <Button
                    size="sm"
                    variant="default"
                    leftSection={<IconUnlink size={16} />}
                    color="red"
                    loading={bulkBusy}
                    onClick={() => {
                      modals.openConfirmModal({
                        title: `Unlink ${selectedKeys.size} products?`,
                        centered: true,
                        confirmProps: { color: "red" },
                        labels: { confirm: "Unlink", cancel: "Cancel" },
                        children: <Text size="sm">This removes the selected links from this canonical.</Text>,
                        onConfirm: () => void runBulkUnlink()
                      });
                    }}
                  >
                    Unlink
                  </Button>
                </Group>
              </Group>

              <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
                <TextInput
                  leftSection={<IconSearch size={16} />}
                  value={moveQuery}
                  onChange={(e) => setMoveQuery(e.currentTarget.value)}
                  placeholder="Find destination canonical… (fuzzy)"
                  w={340}
                />
                <Group gap="sm" wrap="wrap">
                  <Select
                    placeholder="Move to canonical…"
                    value={moveCanonicalId}
                    onChange={setMoveCanonicalId}
                    data={moveOptions.map((c) => ({ value: c._id, label: c.name }))}
                    w={360}
                    searchable={false}
                    nothingFoundMessage="No results"
                  />
                  <Button
                    size="sm"
                    leftSection={<IconArrowRight size={16} />}
                    loading={bulkBusy}
                    disabled={!moveCanonicalId || bulkBusy}
                    onClick={() => void runBulkMove()}
                  >
                    Move
                  </Button>
                  <Button size="sm" variant="subtle" color="gray" disabled={bulkBusy} onClick={() => setSelectedKeys(new Set())}>
                    Clear
                  </Button>
                </Group>
              </Group>
            </Stack>
          ) : null}

          <div style={{ overflowX: "auto", marginTop: 16 }}>
            <Table withTableBorder highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={44}>
                    <Checkbox
                      checked={allSelected}
                      indeterminate={someSelected}
                      onChange={(e) => {
                        const checked = e.currentTarget.checked;
                        setSelectedKeys(() => {
                          if (!detail) return new Set();
                          if (!checked) return new Set();
                          return new Set(detail.linkedProducts.map((p) => `${p.sourceSlug}:${p.itemId}`));
                        });
                      }}
                      aria-label="Select all"
                    />
                  </Table.Th>
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
                    <Table.Td colSpan={7}>
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
