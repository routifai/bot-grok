import { BarChart3 } from "lucide-react";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

const images = new Map<string, string>();

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * A chart's Library thumbnail: the server-rendered PNG (`charts.thumbnail`), fetched once the
 * card is on screen, in the theme the app is in. The chart icon stands in until it arrives.
 */
export function ChartThumbnail({ artifactId, version }: { artifactId: string; version?: number }) {
  const [theme, setTheme] = useState(currentTheme);
  const key = `${artifactId}:${version ?? ""}:${theme}`;
  const [src, setSrc] = useState<string | null>(() => images.get(key) ?? null);

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
    if (cached) return setSrc(cached);
    setSrc(null);
    let cancelled = false;
    rpc.charts
      .thumbnail({ artifactId, format: "png", theme, width: 640, height: 400 })
      .then((image) => {
        const url = `data:${image.mimeType};base64,${image.contentBase64}`;
        images.set(key, url);
        if (!cancelled) setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [artifactId, key, theme]);

  return src ? (
    <img src={src} alt="" className="h-full w-full object-cover" />
  ) : (
    <BarChart3 size={36} strokeWidth={1.5} className="text-muted-foreground/50" aria-hidden />
  );
}
