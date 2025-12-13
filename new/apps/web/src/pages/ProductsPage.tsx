import { useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Container, Group, Stack, Table, Text, TextInput } from "@mantine/core";
import { IconPlus, IconSearch } from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import text from "../ui/text.module.css";
import { canonicalsListWithLinkInfo, type CanonicalLinkInfo } from "../convexFns";
import classes from "./ProductsPage.module.css";

export function ProductsPage(props: { sessionToken: string }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  const items: CanonicalLinkInfo[] =
    useQuery(canonicalsListWithLinkInfo, {
      sessionToken: props.sessionToken,
      limit: 100,
      q: q.trim() ? q.trim() : undefined
    }) ?? [];

  const rows = useMemo(
    () =>
      items.map((row) => (
        <Table.Tr
          key={row.canonical._id}
          className={classes.row}
          onClick={() => navigate(`/products/${row.canonical._id}`)}
        >
          <Table.Td className={classes.nameCell}>
            <Stack gap={2}>
              <Text fw={700} lineClamp={1} title={row.canonical.name}>
                {row.canonical.name}
              </Text>
              {row.canonical.description ? (
                <Text size="xs" c="dimmed" lineClamp={2}>
                  {row.canonical.description}
                </Text>
              ) : (
                <Text size="xs" c="dimmed">
                  No description
                </Text>
              )}
            </Stack>
          </Table.Td>
          <Table.Td ta="right">
            <Badge variant="light" color={row.linkCount > 0 ? "violet" : "gray"} className={text.mono}>
              {row.linkCount}
            </Badge>
          </Table.Td>
          <Table.Td ta="right">
            {row.sourcesPreview.length > 0 ? (
              <div className={classes.chips}>
                {row.sourcesPreview.map((s) => (
                  <Badge key={s.sourceSlug} variant="light" color="gray" radius="xl">
                    {s.displayName}
                  </Badge>
                ))}
              </div>
            ) : (
              <Text size="xs" c="dimmed">
                —
              </Text>
            )}
          </Table.Td>
        </Table.Tr>
      )),
    [items, navigate]
  );

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <PageHeader
          title="Products"
          subtitle="Manage canonical products and their linked source items."
          right={
            <Group gap="sm">
              <TextInput
                leftSection={<IconSearch size={16} />}
                placeholder="Search name or description…"
                value={q}
                onChange={(e) => setQ(e.currentTarget.value)}
                w={320}
              />
              <Button leftSection={<IconPlus size={16} />} onClick={() => navigate("/products/new")}>
                New product
              </Button>
            </Group>
          }
        />

        <Panel>
          <div style={{ overflowX: "auto" }}>
            <Table withTableBorder highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Canonical</Table.Th>
                  <Table.Th ta="right">Links</Table.Th>
                  <Table.Th ta="right">Sources</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.length > 0 ? (
                  rows
                ) : (
                  <Table.Tr>
                    <Table.Td colSpan={3}>
                      <Text c="dimmed" size="sm">
                        No canonicals yet. Create your first one.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </div>
        </Panel>
      </Stack>
    </Container>
  );
}

