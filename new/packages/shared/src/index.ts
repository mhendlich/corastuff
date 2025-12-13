export type SourceType = "http" | "playwright" | "hybrid";

export type RunStatus = "pending" | "running" | "completed" | "failed" | "canceled";

export type DiscoveredProduct = {
  sourceSlug: string;
  itemId?: string;
  name: string;
  url?: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
};

export type StoredImage = {
  hash: string;
  mime: string;
  bytes: number;
  path: string;
  mediaUrl: string;
};

export type ScrapedProduct = DiscoveredProduct & {
  image?: StoredImage;
};

export type ScrapeResult = {
  sourceSlug: string;
  sourceUrl: string;
  scrapedAt: string;
  totalProducts: number;
  products: ScrapedProduct[];
};
