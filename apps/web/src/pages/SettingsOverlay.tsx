import type { AvatarStyle, Bot } from "@aiden/contracts";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import {
  CloudDownload,
  Cpu,
  Gauge,
  Monitor,
  Settings,
  UserRound,
  Volume2,
  XIcon,
} from "lucide-react";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { computersAreUnavailable } from "../components/ComputersUnavailableHint";
import {
  ComputerSettingsPanel,
  GeneralSettingsPanels,
  UpdatesSettingsPanel,
  UsageSettingsPanel,
} from "./AccountSettingsOverlay";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";
import { AidenSettingsPanel } from "./muse/AidenSettingsPanel";
import { GeneralPanel } from "./muse/settings/GeneralPanel";
import { VoicePanel } from "./muse/settings/VoicePanel";
import { VoiceSettingsOverlay } from "./VoiceSettingsOverlay";

export type SettingsSection =
  | "aiden"
  | "general"
  | "models"
  | "voice"
  | "usage"
  | "computer"
  | "updates";

type NavItem = {
  id: SettingsSection;
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
};

export function SettingsOverlay({
  email,
  name,
  usage,
  initialSection = "general",
  avatarStyle,
  onAvatarStyleChange,
  isDeploymentOwner = false,
  sandboxProvider,
  messagingEnabled = false,
  onOpenMessaging,
  onClose,
  onVoiceStatusMaybeChanged,
  museMode = false,
  museBot,
  onMuseBotSave,
}: {
  email?: string | null;
  name: string;
  usage?: { runs: number; inputTokens: number; outputTokens: number } | null;
  initialSection?: SettingsSection;
  avatarStyle: AvatarStyle;
  onAvatarStyleChange: (style: AvatarStyle) => Promise<void>;
  isDeploymentOwner?: boolean;
  sandboxProvider?: string | null;
  messagingEnabled?: boolean;
  onOpenMessaging?: () => void;
  onClose: () => void;
  onVoiceStatusMaybeChanged?: () => void | Promise<void>;
  /** In Muse mode: gates Avatars/Updates off and adds the Aiden section (docs/muse/DESIGN.md). */
  museMode?: boolean;
  /** The person's one Muse bot; required to render the Aiden section. */
  museBot?: Bot | null;
  onMuseBotSave?: (patch: { name?: string; color?: string }) => Promise<void>;
}) {
  const { t } = useLingui();
  const panelRef = useRef<HTMLDivElement>(null);
  const usageRef = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const showComputer = isDeploymentOwner && computersAreUnavailable(sandboxProvider);
  const panelBusy = voiceBusy;

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    if (section === "usage") {
      usageRef.current?.focus();
    }
  }, [section]);

  // "Updates" only covers the desktop app's own auto-update, which isn't a section a
  // Muse person can land on.
  useEffect(() => {
    if (museMode && (section === "updates" || section === "models")) setSection("general");
  }, [museMode, section]);

  const navItems: NavItem[] = [
    ...(museMode
      ? [{ id: "aiden" as const, label: museBot?.name || t`Nova`, icon: UserRound }]
      : []),
    { id: "general", label: t`General`, icon: Settings },
    // The Muse's engine and model are the server's business; only the classic app picks one.
    ...(museMode ? [] : [{ id: "models" as const, label: t`Models`, icon: Cpu }]),
    { id: "voice", label: t`Voice`, icon: Volume2 },
    ...(museMode ? [] : [{ id: "usage" as const, label: t`Usage`, icon: Gauge }]),
    ...(showComputer ? [{ id: "computer" as const, label: t`Computer`, icon: Monitor }] : []),
    ...(museMode ? [] : [{ id: "updates" as const, label: t`Updates`, icon: CloudDownload }]),
  ];

  const sectionTitle =
    navItems.find((item) => item.id === section)?.label ??
    (section === "general" ? t`General` : t`Settings`);

  const closeLabel =
    section === "models"
      ? t`Close model settings`
      : section === "voice"
        ? t`Close voice settings`
        : t`Close user settings`;

  async function refreshVoiceStatus() {
    await onVoiceStatusMaybeChanged?.();
  }

  function leaveSettings(next: () => void) {
    if (panelBusy) return;
    void refreshVoiceStatus().finally(next);
  }

  function requestClose() {
    leaveSettings(onClose);
  }

  const widePane = section === "models" || section === "voice";

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (panelBusy) {
          details.cancel();
          return;
        }
        requestClose();
      }}
    >
      <DialogContent
        ref={panelRef}
        data-testid="user-settings"
        data-settings-section={section}
        showCloseButton={false}
        initialFocus={() =>
          section === "usage" ? (usageRef.current ?? panelRef.current) : panelRef.current
        }
        className={`flex max-h-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-h-[calc(100%-5rem)] ${
          widePane && !museMode
            ? "h-[min(760px,calc(100%-2rem))] w-[min(1080px,calc(100%-2rem))] sm:max-w-[1080px]"
            : "h-[min(720px,calc(100%-2rem))] w-[min(920px,calc(100%-2rem))] sm:max-w-[920px]"
        }`}
      >
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            data-testid="settings-nav"
            aria-label={t`Settings`}
            className="flex shrink-0 flex-row gap-1 overflow-x-auto overscroll-x-contain border-b border-border px-3 py-3 max-sm:justify-between md:w-[200px] md:flex-col md:overflow-y-auto md:border-b-0 md:border-e md:px-3 md:py-4"
          >
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = item.id === section;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`settings-nav-${item.id}`}
                  aria-current={active ? "page" : undefined}
                  disabled={panelBusy}
                  onClick={() => setSection(item.id)}
                  className={`flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13.5px] transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                    active
                      ? museMode
                        ? "bg-primary/10 font-medium text-foreground"
                        : "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <Icon className="size-4 shrink-0 max-sm:hidden" strokeWidth={1.75} />
                  <span className="whitespace-nowrap">{item.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-start justify-between gap-4 px-6 pt-6 sm:px-8 sm:pt-7">
              <DialogTitle
                className={
                  museMode
                    ? "text-[28px] font-bold tracking-[-0.025em] text-foreground"
                    : "text-2xl font-medium text-foreground"
                }
              >
                {sectionTitle}
              </DialogTitle>
              <DialogClose
                aria-label={closeLabel}
                disabled={panelBusy}
                render={<Button variant="ghost" size="icon-sm" />}
              >
                <XIcon />
              </DialogClose>
            </div>

            <div
              className={`min-h-0 flex-1 ${
                !museMode && (section === "models" || section === "voice")
                  ? "flex flex-col overflow-hidden"
                  : "rk-scroll overflow-y-auto overscroll-contain px-6 pb-6 pt-5 sm:px-8 sm:pb-8"
              }`}
            >
              {section === "aiden" && museMode && museBot && onMuseBotSave ? (
                <AidenSettingsPanel bot={museBot} onSave={onMuseBotSave} />
              ) : null}
              {section === "general" && museMode ? (
                <GeneralPanel name={name} email={email} isDeploymentOwner={isDeploymentOwner} />
              ) : null}
              {section === "general" && !museMode ? (
                <GeneralSettingsPanels
                  email={email}
                  name={name}
                  avatarStyle={avatarStyle}
                  onAvatarStyleChange={onAvatarStyleChange}
                  messagingEnabled={messagingEnabled}
                  onOpenMessaging={
                    onOpenMessaging ? () => leaveSettings(onOpenMessaging) : undefined
                  }
                  isDeploymentOwner={isDeploymentOwner}
                  museMode={museMode}
                />
              ) : null}
              {section === "usage" ? (
                <UsageSettingsPanel usage={usage} panelRef={usageRef} />
              ) : null}
              {section === "computer" && showComputer ? <ComputerSettingsPanel /> : null}
              {section === "updates" && !museMode ? <UpdatesSettingsPanel /> : null}
              {section === "models" && !museMode ? (
                <ModelSettingsOverlay embedded onClose={requestClose} />
              ) : null}
              {section === "voice" && museMode ? <VoicePanel onBusyChange={setVoiceBusy} /> : null}
              {section === "voice" && !museMode ? (
                <VoiceSettingsOverlay embedded onClose={requestClose} onBusyChange={setVoiceBusy} />
              ) : null}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
