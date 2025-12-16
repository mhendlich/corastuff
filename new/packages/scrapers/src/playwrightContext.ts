import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type PlaywrightBrowserType = "chromium" | "firefox" | "webkit";

export type PlaywrightContextProfile = {
  browserType?: PlaywrightBrowserType;
  userAgent?: string;
  locale?: string;
  viewport?: { width: number; height: number };
  stealth?: boolean;
  initScripts?: string[];
  headless?: boolean;
  slowMoMs?: number;
};

export type PlaywrightRunArtifactType = "html" | "screenshot" | "other";

export type PlaywrightRunArtifact = {
  key: string;
  type: PlaywrightRunArtifactType;
  absPath: string;
};

export type PlaywrightRunArtifactsOptions = {
  dir: string;
  prefix?: string;
  when?: "always" | "error";
  capture?: {
    html?: boolean;
    screenshot?: boolean;
    trace?: boolean;
  };
  onArtifact?: (artifact: PlaywrightRunArtifact) => void;
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

function safePrefix(raw: string | undefined) {
  const cleaned = (raw ?? "").trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned ? `${cleaned}_` : "";
}

async function maybeWriteArtifact(
  artifacts: PlaywrightRunArtifactsOptions | undefined,
  artifact: { key: string; type: PlaywrightRunArtifactType; fileName: string; data: string | Buffer }
) {
  if (!artifacts) return;
  try {
    await mkdir(artifacts.dir, { recursive: true });
    const absPath = path.join(artifacts.dir, artifact.fileName);
    await writeFile(absPath, artifact.data);
    artifacts.onArtifact?.({ key: artifact.key, type: artifact.type, absPath });
  } catch {
    // best-effort
  }
}

async function capturePageArtifacts(
  page: Page | null,
  artifacts: PlaywrightRunArtifactsOptions | undefined,
  phase: "final" | "error"
) {
  if (!page || !artifacts) return;
  const when = artifacts.when ?? "error";
  const shouldCapture = when === "always" || phase === "error";
  if (!shouldCapture) return;

  const capture = artifacts.capture ?? {};
  const prefix = safePrefix(artifacts.prefix);

  if (capture.screenshot !== false) {
    try {
      const fileName = `pw_${prefix}${phase}.png`;
      const absPath = path.join(artifacts.dir, fileName);
      await mkdir(artifacts.dir, { recursive: true });
      await page.screenshot({ path: absPath, fullPage: true });
      artifacts.onArtifact?.({ key: `pw_${prefix}${phase}.png`, type: "screenshot", absPath });
    } catch {
      // ignore
    }
  }

  if (capture.html !== false) {
    try {
      const html = await page.content();
      await maybeWriteArtifact(artifacts, {
        key: `pw_${prefix}${phase}.html`,
        type: "html",
        fileName: `pw_${prefix}${phase}.html`,
        data: html
      });
    } catch {
      // ignore
    }
  }
}

export async function withPlaywrightContext<T>(
  profile: PlaywrightContextProfile,
  fn: (context: BrowserContext, browser: Browser) => Promise<T>,
  options?: { artifacts?: PlaywrightRunArtifactsOptions }
): Promise<T> {
  const browserType = pickBrowserType(profile.browserType);
  const stealth = profile.stealth === true;
  const userAgent = normalizeLocale(profile.userAgent) ?? DEFAULT_DESKTOP_UA;
  const locale = normalizeLocale(profile.locale) ?? "de-DE";
  const viewport = profile.viewport ?? DEFAULT_VIEWPORT;
  const headless = profile.headless !== false;
  const slowMo = typeof profile.slowMoMs === "number" && Number.isFinite(profile.slowMoMs) && profile.slowMoMs > 0 ? Math.trunc(profile.slowMoMs) : 0;
  const artifacts = options?.artifacts;

  const launchArgs: string[] = [];
  if (stealth && browserType === chromium) {
    launchArgs.push("--disable-blink-features=AutomationControlled");
  }
  if (browserType === chromium) {
    launchArgs.push("--no-sandbox");
  }

  const browser = await browserType.launch({
    headless,
    ...(slowMo > 0 ? { slowMo } : {}),
    ...(launchArgs.length > 0 ? { args: launchArgs } : {})
  });

  try {
    const context = await browser.newContext({
      userAgent,
      locale,
      viewport
    });

    let lastPage: Page | null = null;
    context.on("page", (p) => {
      lastPage = p;
    });

    const when = artifacts?.when ?? "error";
    const capture = artifacts?.capture ?? {};
    const captureTrace = capture.trace === true && artifacts?.dir;
    if (captureTrace && (when === "always" || when === "error")) {
      try {
        await mkdir(artifacts!.dir, { recursive: true });
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      } catch {
        // ignore
      }
    }

    if (stealth) {
      await context.addInitScript(buildStealthInitScript(locale));
    }
    for (const script of profile.initScripts ?? []) {
      if (typeof script === "string" && script.trim()) {
        await context.addInitScript(script);
      }
    }

    try {
      const result = await fn(context, browser);
      await capturePageArtifacts(lastPage, artifacts, "final");
      return result;
    } catch (err) {
      await capturePageArtifacts(lastPage, artifacts, "error");
      throw err;
    } finally {
      if (captureTrace && artifacts) {
        try {
          const prefix = safePrefix(artifacts.prefix);
          const fileName = `pw_${prefix}trace.zip`;
          const absPath = path.join(artifacts.dir, fileName);
          await context.tracing.stop({ path: absPath });
          artifacts.onArtifact?.({ key: fileName, type: "other", absPath });
        } catch {
          // ignore
        }
      }
      await context.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}
