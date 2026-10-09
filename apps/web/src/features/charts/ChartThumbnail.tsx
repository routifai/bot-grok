import { useLingui } from "@lingui/react/macro";
import { BarChart3 } from "lucide-react";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

/** Data URLs of rendered thumbnails, oldest evicted first so a long Library stays bounded. */
const MAX_CACHED = 60;
const images = new Map<string, string>();

function remember(key: string, url: string) {
  images.delete(key);
  images.set(key, url);
  while (images.size > MAX_CACHED) {
    const oldest = images.keys().next().value;
    if (oldest === undefined) break;
    images.delete(oldest);
  }
}

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * A chart's Library thumbnail: the server-rendered PNG (`charts.thumbnail`), fetched once the
 * card is on screen, in the theme the app is in. The chart icon stands in until it arrives, and
 * stays (with a quiet tooltip) when the server could not draw it.
 */
export function ChartThumbnail({ artifactId, version }: { artifactId: string; version?: number }) {
  const { t } = useLingui();
  const [theme, setTheme] = useState(currentTheme);
  const key = `${artifactId}:${version ?? ""}:${theme}`;
  const [src, setSrc] = useState<string | null>(() => images.get(key) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const cached = images.get(key);
    setFailed(false);
    if (cached) return setSrc(cached);
    setSrc(null);
    let cancelled = false;
    rpc.charts
      .thumbnail({ artifactId, format: "png", theme, width: 640, height: 400 })
      .then((image) => {
        const url = `data:${image.mimeType};base64,${image.contentBase64}`;
        remember(key, url);
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, key, theme]);

  return src ? (
    <img src={src} alt="" className="h-full w-full object-cover" />
  ) : (
    <span
      title={failed ? t`Preview unavailable` : undefined}
      className="grid h-full w-full place-items-center"
    >
      <BarChart3 size={36} strokeWidth={1.5} className="text-muted-foreground/50" aria-hidden />
    </span>
  );
}
