import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@aiden/ui-web";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";

/**
 * The 47-second film: nothing video-related is in the page until the button is pressed. The
 * dialog unmounts its content on close, which stops playback.
 */
export function FilmButton() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="link"
        type="button"
        onClick={() => setOpen(true)}
        className="h-auto p-0 text-[15px] font-normal text-welcome-ink-2 underline underline-offset-4 hover:text-welcome-ink"
      >
        <Trans>Watch the 47-second film</Trans>
      </Button>
      <DialogPortal>
        <DialogOverlay className="bg-black/90" />
      </DialogPortal>
      <DialogContent
        showCloseButton={false}
        className="w-[min(1100px,92vw)] max-w-[min(1100px,92vw)] gap-0 overflow-hidden bg-black p-0 ring-0 sm:max-w-[min(1100px,92vw)]"
      >
        <DialogTitle className="sr-only">
          <Trans>Nova, in 47 seconds</Trans>
        </DialogTitle>
        <video
          controls
          autoPlay
          playsInline
          preload="none"
          poster="/welcome/nova-film-poster.jpg"
          className="block w-full bg-black"
        >
          <source src="/welcome/nova-film.mp4" type="video/mp4" />
          <track
            kind="captions"
            srcLang="en"
            label="English"
            src="/welcome/nova-film.en.vtt"
            default
          />
        </video>
        <DialogClose
          render={
            <Button
              variant="outline"
              size="sm"
              className="absolute top-3 right-3 rounded-full border-welcome-paper/25 bg-welcome-paper/15 text-welcome-paper hover:bg-welcome-paper/25"
            />
          }
        >
          <Trans>Close</Trans>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
