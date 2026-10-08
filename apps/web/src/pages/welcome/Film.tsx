import { Trans, useLingui } from "@lingui/react/macro";
import { Play } from "lucide-react";
import { useRef, useState } from "react";

const asset = (name: string) => `${import.meta.env.BASE_URL}welcome/${name}`;

export function Film() {
  const { t } = useLingui();
  const video = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);

  return (
    <section className="pt-[72px] pb-6" aria-labelledby="welcome-film">
      <h2
        id="welcome-film"
        className="mb-9 text-center font-welcome text-[clamp(34px,4.4vw,56px)] font-light leading-[1.02] tracking-[-0.02em] text-balance"
      >
        <Trans>Watch the film.</Trans>
      </h2>
      <div className="relative mx-auto aspect-video max-w-[1000px] overflow-hidden rounded-[28px] border border-welcome-hair-2 bg-welcome-win shadow-[0_40px_120px_rgba(0,0,0,0.6)]">
        <video
          ref={video}
          className="size-full object-cover"
          preload="none"
          playsInline
          controls={started}
          poster={asset("nova-film-poster.jpg")}
          src={asset("nova-film.mp4")}
        >
          <track
            kind="captions"
            srcLang="en"
            label="English"
            src={asset("nova-film.en.vtt")}
            default
          />
        </video>
        {!started && (
          <button
            type="button"
            aria-label={t`Play the film`}
            onClick={() => {
              setStarted(true);
              void video.current?.play();
            }}
            className="group absolute inset-0 grid place-items-center outline-none"
          >
            <span className="grid size-20 place-items-center rounded-full bg-welcome-ink text-welcome-night shadow-[0_8px_40px_rgba(0,0,0,0.5)] transition-transform group-hover:scale-105 group-focus-visible:ring-2 group-focus-visible:ring-welcome-glow group-focus-visible:ring-offset-4 group-focus-visible:ring-offset-welcome-night motion-reduce:transition-none">
              <Play className="size-8 translate-x-0.5 fill-current" aria-hidden="true" />
            </span>
          </button>
        )}
      </div>
    </section>
  );
}
