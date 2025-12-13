import { chromium, firefox, webkit, type Browser, type BrowserContext } from "playwright";

export type PlaywrightBrowserType = "chromium" | "firefox" | "webkit";

export type PlaywrightContextProfile = {
  browserType?: PlaywrightBrowserType;
  userAgent?: string;
  locale?: string;
  viewport?: { width: number; height: number };
  stealth?: boolean;
  initScripts?: string[];
};

const DEFAULT_DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;

function normalizeLocale(value: string | undefined) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw || undefined;
}

function languagesForLocale(locale: string | undefined): string[] {
  const loc = normalizeLocale(locale) ?? "de-DE";
  const base = loc.split("-", 1)[0] ?? loc;
  const candidates = [loc, base, "en-US", "en"];
  return Array.from(new Set(candidates.map((x) => x.trim()).filter(Boolean)));
}

function buildStealthInitScript(locale: string | undefined): string {
  const languages = languagesForLocale(locale);
  return `
Object.defineProperty(navigator, "webdriver", { get: () => undefined });
Object.defineProperty(navigator, "languages", { get: () => ${JSON.stringify(languages)} });
Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
`;
}

function pickBrowserType(browserType: PlaywrightBrowserType | undefined) {
  if (browserType === "firefox") return firefox;
  if (browserType === "webkit") return webkit;
  return chromium;
}

export async function withPlaywrightContext<T>(
  profile: PlaywrightContextProfile,
  fn: (context: BrowserContext, browser: Browser) => Promise<T>
): Promise<T> {
  const browserType = pickBrowserType(profile.browserType);
  const stealth = profile.stealth === true;
  const userAgent = normalizeLocale(profile.userAgent) ?? DEFAULT_DESKTOP_UA;
  const locale = normalizeLocale(profile.locale) ?? "de-DE";
  const viewport = profile.viewport ?? DEFAULT_VIEWPORT;

  const launchArgs: string[] = [];
  if (stealth && browserType === chromium) {
    launchArgs.push("--disable-blink-features=AutomationControlled");
  }
  if (browserType === chromium) {
    launchArgs.push("--no-sandbox");
  }

  const browser = await browserType.launch({
    headless: true,
    ...(launchArgs.length > 0 ? { args: launchArgs } : {})
  });

  try {
    const context = await browser.newContext({
      userAgent,
      locale,
      viewport
    });

    if (stealth) {
      await context.addInitScript(buildStealthInitScript(locale));
    }
    for (const script of profile.initScripts ?? []) {
      if (typeof script === "string" && script.trim()) {
        await context.addInitScript(script);
      }
    }

    try {
      return await fn(context, browser);
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

