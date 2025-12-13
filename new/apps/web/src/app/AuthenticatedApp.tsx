import { useMutation, useQuery } from "convex/react";
import { useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Box, Container, Paper, Stack, Text, Title } from "@mantine/core";
import { authLogout, authValidateSession } from "../convexFns";
import { DashboardPage } from "../pages/DashboardPage";
import { InsightsPage } from "../pages/InsightsPage";
import { LinkProductsPage } from "../pages/LinkProductsPage";
import { ProductsPage } from "../pages/ProductsPage";
import { CanonicalCreatePage } from "../pages/CanonicalCreatePage";
import { CanonicalDetailPage } from "../pages/CanonicalDetailPage";
import { CanonicalEditPage } from "../pages/CanonicalEditPage";
import { PricesPage } from "../pages/PricesPage";
import { ProductPriceDetailPage } from "../pages/ProductPriceDetailPage";
import { CanonicalPriceDetailPage } from "../pages/CanonicalPriceDetailPage";
import { AppLayout } from "./AppLayout";
import { NotFoundPage } from "./NotFoundPage";
import { PlaceholderPage } from "./PlaceholderPage";
import backdrop from "./Backdrop.module.css";

export function AuthenticatedApp(props: { sessionToken: string; onLoggedOut: () => void }) {
  const session = useQuery(authValidateSession, { sessionToken: props.sessionToken });
  const logout = useMutation(authLogout);

  useEffect(() => {
    if (session === null) {
      props.onLoggedOut();
    }
  }, [session, props.onLoggedOut]);

  if (session === undefined) {
    return (
      <Box className={backdrop.root}>
        <Container size="sm" py={72}>
          <Paper withBorder radius="lg" p="xl" className={backdrop.glass}>
            <Stack gap="xs">
              <Title order={2}>Corastuff</Title>
              <Text c="dimmed">Checking session…</Text>
            </Stack>
          </Paper>
        </Container>
      </Box>
    );
  }

  if (session === null) {
    return (
      <Box className={backdrop.root}>
        <Container size="sm" py={72}>
          <Paper withBorder radius="lg" p="xl" className={backdrop.glass}>
            <Stack gap="xs">
              <Title order={2}>Corastuff</Title>
              <Text c="dimmed">Session expired.</Text>
            </Stack>
          </Paper>
        </Container>
      </Box>
    );
  }

  const handleLogout = async () => {
    try {
      await logout({ sessionToken: props.sessionToken });
    } finally {
      props.onLoggedOut();
    }
  };

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout session={session} onLogout={handleLogout} />}>
          <Route path="/" element={<DashboardPage sessionToken={props.sessionToken} />} />
          <Route path="/insights" element={<InsightsPage sessionToken={props.sessionToken} />} />
          <Route path="/products" element={<ProductsPage sessionToken={props.sessionToken} />} />
          <Route path="/products/new" element={<CanonicalCreatePage sessionToken={props.sessionToken} />} />
          <Route path="/products/:canonicalId" element={<CanonicalDetailPage sessionToken={props.sessionToken} />} />
          <Route path="/products/:canonicalId/edit" element={<CanonicalEditPage sessionToken={props.sessionToken} />} />
          <Route path="/link" element={<LinkProductsPage sessionToken={props.sessionToken} />} />
          <Route path="/prices" element={<PricesPage sessionToken={props.sessionToken} />} />
          <Route
            path="/prices/product/:sourceSlug/:itemId"
            element={<ProductPriceDetailPage sessionToken={props.sessionToken} />}
          />
          <Route
            path="/prices/canonical/:canonicalId"
            element={<CanonicalPriceDetailPage sessionToken={props.sessionToken} />}
          />
          <Route path="/amazon-pricing" element={<PlaceholderPage title="Amazon Pricing" />} />
          <Route path="/scrapers" element={<PlaceholderPage title="Scrapers" />} />
          <Route path="/scrapers/schedules" element={<PlaceholderPage title="Automation" />} />
          <Route path="/history" element={<PlaceholderPage title="History" />} />
          <Route path="/scrapers/builder" element={<PlaceholderPage title="Scraper Builder" />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
