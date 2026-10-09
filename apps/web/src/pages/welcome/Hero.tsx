import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { desktopBridge } from "../../lib/desktop";
import { WindowChrome } from "../WindowChrome";
import { NovaMark } from "./Brand";
import { FOCUS, GetStarted, GUTTER } from "./Cta";

const LOOP_SRC = "/welcome/hero-loop.mp4";
const FILM_SRC = "/welcome/nova-film.mp4";
const POSTER = "/welcome/nova-film-poster.jpg";
const CAPTIONS = "/welcome/nova-film.en.vtt";

/** Time since you arrived, as T+ hh:mm:ss. */
function MissionClock() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t0 = performance.now();
    const id = window.setInterval(
      () => setSeconds(Math.floor((performance.now() - t0) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, []);
  const text = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  return (
    <span
      aria-hidden="true"
      className="mr-2 font-mono text-xs tracking-[0.08em] text-welcome-night-ink-3 tabular-nums max-[560px]:hidden"
    >
      T+ <b className="font-normal text-welcome-night-ink-2">{text}</b>
    </span>
  );
}

const PILL =
  "cursor-pointer rounded-full border border-welcome-paper/20 bg-welcome-night-pill/60 px-3.5 py-2 text-[13px] text-welcome-night-ink backdrop-blur-[10px]";

/** The dark film hero: a silent loop behind the words; "Watch the film" plays the cut in place. */
export function Hero() {
  const { t } = useLingui();
  const videoRef = useRef<HTMLVideoElement>(null);
  const first = useRef(true);
  const [film, setFilm] = useState(false);
  const [muted, setMuted] = useState(true);

  const setMode = (on: boolean) => {
    setFilm(on);
    setMuted(true);
  };

  // Switch the picture between the loop and the film; captions show only for the film.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    for (const track of Array.from(v.textTracks ?? [])) track.mode = film ? "showing" : "hidden";
    if (first.current) {
      first.current = false;
      return;
    }
    v.currentTime = 0;
    Promise.resolve(v.play()).catch(() => {});
  }, [film]);

  useEffect(() => {
    if (!film) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFilm(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [film]);

  return (
    <section className={`welcome-hero relative z-1 h-svh min-h-[620px] overflow-hidden bg-black`}>
      <video
        ref={videoRef}
        src={film ? FILM_SRC : LOOP_SRC}
        poster={POSTER}
        autoPlay
        muted={muted}
        loop={!film}
        playsInline
        preload="auto"
        onEnded={() => film && setMode(false)}
        className={`absolute inset-0 size-full object-cover transition-transform duration-[1200ms] ease-[cubic-bezier(.2,.7,.2,1)] ${film ? "scale-[1.02]" : ""}`}
      >
        <track kind="captions" srcLang="en" label="English" src={CAPTIONS} />
      </video>
      <div
        className={`welcome-shade absolute inset-0 transition-opacity duration-800 ${film ? "pointer-events-none opacity-0" : ""}`}
      />
      <div
        className={`absolute inset-x-0 top-0 z-4 bg-black transition-[height] duration-900 ease-[cubic-bezier(.2,.7,.2,1)] ${film ? "h-[11vh]" : "h-0"}`}
      />
      <div
        className={`absolute inset-x-0 bottom-0 z-4 bg-black transition-[height] duration-900 ease-[cubic-bezier(.2,.7,.2,1)] ${film ? "h-[11vh]" : "h-0"}`}
      />

      <div
        className={`relative z-3 pt-safe transition-opacity duration-500 ${GUTTER} ${film ? "pointer-events-none opacity-0" : ""}`}
      >
        <header className="flex items-center gap-5 py-[22px] max-[560px]:gap-3">
          {/* Window controls only inside the desktop app; on the web the wordmark sits flush left. */}
          {desktopBridge() ? <WindowChrome /> : null}
          <NovaMark />
          <span className="flex-1" />
          <MissionClock />
          <Link
            to="/sign-in"
            className={`text-sm text-welcome-night-ink-2 hover:text-welcome-night-ink ${FOCUS}`}
          >
            <Trans>Sign in</Trans>
          </Link>
          <Link
            to="/sign-up"
            className={`rounded-full border border-welcome-night-line/16 px-4 py-2 text-sm text-welcome-night-ink ${FOCUS}`}
          >
            <Trans>Get started</Trans>
          </Link>
        </header>
      </div>

      <div
        className={`absolute inset-x-0 bottom-[max(9vh,52px)] z-3 px-4 text-center transition-[opacity,translate] duration-700 ${film ? "pointer-events-none translate-y-5 opacity-0" : ""}`}
      >
        <h1 className="welcome-display text-[clamp(42px,7vw,104px)] leading-[0.98] font-normal tracking-[-0.035em] text-balance [text-shadow:0_2px_40px_rgb(0_0_0/0.6)] max-[560px]:text-[clamp(38px,11.5vw,56px)]">
          <Trans>
            Hand it off.
            <br />
            Nova's already on it.
          </Trans>
        </h1>
        <p className="mx-auto mt-[18px] max-w-[44ch] text-[clamp(16px,1.4vw,19px)] leading-[1.55] text-welcome-night-sub [text-shadow:0_1px_20px_rgb(0_0_0/0.7)]">
          <Trans>Ask once and get on with your day.</Trans>
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <GetStarted tone="night" />
          <button
            type="button"
            onClick={() => setMode(true)}
            className={`inline-flex cursor-pointer items-center gap-2.5 rounded-full border border-welcome-paper/22 bg-welcome-paper/8 py-3 pr-[18px] pl-3 text-[15px] font-semibold text-welcome-night-ink backdrop-blur-[14px] ${FOCUS}`}
          >
            <i
              aria-hidden="true"
              className="grid size-[26px] place-items-center rounded-full bg-welcome-night-ink"
            >
              <span className="ml-0.5 size-0 border-y-[5px] border-l-8 border-y-transparent border-l-welcome-night" />
            </i>
            <Trans>Watch the film</Trans>
            <small className="font-mono text-[11px] font-normal text-welcome-night-ink-2">
              0:47
            </small>
          </button>
        </div>
      </div>

      <div
        className={`absolute right-[clamp(16px,4vw,48px)] bottom-[calc(11vh+16px)] z-5 flex gap-2 transition-opacity delay-400 duration-500 ${film ? "opacity-100" : "pointer-events-none opacity-0"}`}
      >
        <button type="button" className={`${PILL} ${FOCUS}`} onClick={() => setMuted((m) => !m)}>
          {muted ? t`Sound off` : t`Sound on`}
        </button>
        <button type="button" className={`${PILL} ${FOCUS}`} onClick={() => setMode(false)}>
          <Trans>Close</Trans>
        </button>
      </div>

      <span
        aria-hidden="true"
        className={`absolute bottom-[22px] left-1/2 z-3 -translate-x-1/2 font-mono text-[11px] tracking-[0.2em] text-welcome-night-ink-2 transition-opacity duration-500 ${film ? "opacity-0" : ""}`}
      >
        <Trans>SCROLL</Trans>
      </span>
    </section>
  );
}
