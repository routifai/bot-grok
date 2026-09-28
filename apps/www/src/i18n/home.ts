import { DEMO_ROSTER, type RosterBot } from "../demo";
import { SITE_DESCRIPTION } from "../site";
import type { Locale } from "./locales";

export type HomeCopy = {
  title: string;
  description: string;
  ogImageAlt: string;
  availableLanguage: string;
  skipToContent: string;
  nav: {
    home: string;
    primary: string;
    menu: string;
    product: string;
    bots: string;
    selfHost: string;
    plans: string;
    getStarted: string;
  };
  hero: {
    badge: string;
    pill: string;
    heading: string;
    lead: string;
    getStarted: string;
    secondaryCta: string;
  };
  selfHost: {
    eyebrow: string;
    heading: string;
    copy: string;
    features: Array<{ title: string; body: string }>;
  };
  roster: {
    eyebrow: string;
    heading: string;
    copy: string;
    bots: RosterBot[];
  };
  openSource: {
    eyebrow: string;
    heading: string;
    copy: string;
    selfHostTitle: string;
    selfHostMeta: string;
    selfHostItems: string[];
    selfHostGetStarted: string;
    cloudTitle: string;
    cloudBadge: string;
    cloudMeta: string;
    cloudItems: string[];
    getStarted: string;
  };
  cta: {
    heading: string;
    copy: string;
    getStarted: string;
    secondaryCta: string;
    privateValue: string;
    selfHostValue: string;
    stats: Array<{ value: "model" | "audit" | "private" | "selfHost"; label: string }>;
  };
  getStartedDialog: {
    closeLabel: string;
    eyebrow: string;
    title: string;
    copy: string;
    selfHostNow: string;
    selfHostHint: string;
    cloudWaitlist: string;
    cloudHint: string;
    back: string;
    successTitle: string;
    successCopy: string;
    done: string;
  };
  waitlist: {
    emailLabel: string;
    placeholder: string;
    submit: string;
    joining: string;
    success: string;
    added: string;
    error: string;
  };
  footer: {
    navLabel: string;
    languagesLabel: string;
    links: {
      about: string;
      support: string;
      privacy: string;
    };
  };
};

const EN_ROSTER = DEMO_ROSTER;

const DE_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "nova/sales-outbound",
    desc: "Recherchiert nachts Accounts, bewertet Intent, entwirft in deinem Ton und hinterlässt eine Review-Liste.",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "nova/inbox-manager",
    desc: "Archiviert den Lärm, antwortet auf Routine-Threads und parkt Entwürfe, die du lesen solltest.",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "nova/talent-scout",
    desc: "Liest jede Bewerbung, shortlistet nach deiner Latte und schreibt die Intro-Mails.",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "nova/expense-manager",
    desc: "Ordnet Belege den Buchungen zu, reicht den Report ein und fragt nach, statt zu raten.",
  },
  {
    name: "Bug Triage",
    color: "#D9508A",
    slug: "nova/bug-triage",
    desc: "Reproduziert Reports in einem echten Browser und hängt die Schritte an das Issue.",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "nova/account-manager",
    desc: "Hält Renewal-Kontext, beantwortet bekannte Fragen und eskaliert den Rest.",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "nova/paid-media",
    desc: "Überwacht den Spend täglich, pausiert, was nicht konvertiert, und meldet, was sich geändert hat.",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "nova/chief-of-staff",
    desc: "Führt die Woche: Briefings, Buchungen und Übergaben zwischen deinen anderen Bots.",
  },
];

const KO_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "nova/sales-outbound",
    desc: "밤새 계정을 조사하고 의도를 점수한 뒤, 당신 말투로 초안을 써 검토 목록을 남깁니다.",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "nova/inbox-manager",
    desc: "잡음을 보관처리하고, 루틴 스레드에 답하며, 확인이 필요한 초안은 보류합니다.",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "nova/talent-scout",
    desc: "지원서를 모두 읽고 기준에 맞게 숏리스트한 뒤 소개 메일을 작성합니다.",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "nova/expense-manager",
    desc: "영수증과 결제를 맞추고 리포트를 제출하며, 추측하기 전에 묻습니다.",
  },
  {
    name: "Bug Triage",
    color: "#D9508A",
    slug: "nova/bug-triage",
    desc: "실제 브라우저에서 리포트를 재현하고 이슈에 재현 절차를 붙입니다.",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "nova/account-manager",
    desc: "갱신 맥락을 유지하고 알려진 질문에 답하며, 나머지는 에스컬레이션합니다.",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "nova/paid-media",
    desc: "매일 지출을 지켜보고 전환되지 않는 건 일시정지한 뒤, 바뀐 점을 보고합니다.",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "nova/chief-of-staff",
    desc: "한 주를 운영합니다: 브리핑, 예약, 다른 봇 사이의 핸드오프.",
  },
];

const ZH_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "nova/sales-outbound",
    desc: "夜间调研客户、评估意向，用你的语气起草跟进，并留下待审清单。",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "nova/inbox-manager",
    desc: "归档杂音、回复例行邮件，把需要你过目的草稿先搁置起来。",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "nova/talent-scout",
    desc: "通读每份简历，按你的标准筛出候选名单，并写好介绍邮件。",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "nova/expense-manager",
    desc: "核对票据与账目、提交报销，拿不准时先问而不是猜。",
  },
  {
    name: "Bug Triage",
    color: "#D9508A",
    slug: "nova/bug-triage",
    desc: "在真实浏览器里复现报告，并把复现步骤附到工单上。",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "nova/account-manager",
    desc: "掌握续约背景，回答常见问题，其余的自动升级给你。",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "nova/paid-media",
    desc: "每天盯投放，暂停没有转化的广告，并汇报发生了什么变化。",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "nova/chief-of-staff",
    desc: "统筹整周：准备简报、安排日程，并协调其他 Bot 之间的交接。",
  },
];

const HOME_COPY: Record<Locale, HomeCopy> = {
  en: {
    title: "Nova | A private Grok Bot alternative",
    description: SITE_DESCRIPTION,
    ogImageAlt:
      "Nova. AI teammates you actually own. Your keys, your model, your machine.",
    availableLanguage: "English",
    skipToContent: "Skip to content",
    nav: {
      home: "Nova home",
      primary: "Primary",
      menu: "Menu",
      product: "Product",
      bots: "Bots",
      selfHost: "Self-host",
      plans: "Plans",
      getStarted: "Get started",
    },
    hero: {
      badge: "Private",
      pill: "Self-hosted",
      heading: "AI teammates you actually own",
      lead: "Nova is a private Grok Bot alternative. Give a bot real work. It signs in to your tools, uses them the way you do, and comes back when it needs you.",
      getStarted: "Get started",
      secondaryCta: "See it in action",
    },
    selfHost: {
      eyebrow: "Self-hosted",
      heading: "The computer is yours",
      copy: "Run Nova on your machine. Your keys, your model, your data.",
      features: [
        {
          title: "Any model, your key",
          body: "Point a bot at Claude, GPT, Grok, or a local model. Swap per bot: the cheap one triages, the smart one writes.",
        },
        {
          title: "Readable routines",
          body: "Show a bot a workflow once and it saves a routine as plain Markdown you can read, edit, and commit.",
        },
        {
          title: "Approvals that hold",
          body: "Set what a bot may do alone and what it must ask about. Every action lands in an audit log you own.",
        },
      ],
    },
    roster: {
      eyebrow: "Bot Templates",
      heading: "Give each bot a job",
      copy: "Start a new bot and it interviews you. A few questions about the work, how you write, and where it lives. Then it gets going.",
      bots: EN_ROSTER,
    },
    openSource: {
      eyebrow: "Deployment",
      heading: "No pricing tricks. Just two ways to run it.",
      copy: "Nova is a private product that runs on your own machine with your own model keys. Nothing is gated, nothing phones home.",
      selfHostTitle: "Self-host",
      selfHostMeta: "Available today",
      selfHostItems: [
        "Docker runner and sandboxed browser",
        "Bring your own model keys",
        "Routines, memory, and audit log",
        "Unlimited bots, no seats, no limits",
        "Direct email support",
      ],
      selfHostGetStarted: "Get started",
      cloudTitle: "Cloud",
      cloudBadge: "Coming soon",
      cloudMeta: "Bring your own keys, we run the computers",
      cloudItems: [
        "Managed sandboxes, always on",
        "Your keys, your model spend",
        "Same bots, same routines, no migration",
      ],
      getStarted: "Get started",
    },
    cta: {
      heading: "Meet your first bot",
      copy: "Give Nova something you have been putting off and let it handle the follow-through.",
      getStarted: "Get started",
      secondaryCta: "See it in action",
      privateValue: "Private",
      selfHostValue: "Self-host",
      stats: [
        { value: "model", label: "Your key, your model" },
        { value: "audit", label: "Every action logged" },
        { value: "private", label: "No seats, no gates" },
        { value: "selfHost", label: "Your machine" },
      ],
    },
    getStartedDialog: {
      closeLabel: "Close get started dialog",
      eyebrow: "Get started",
      title: "How do you want to start?",
      copy: "Self-host on your machine, or join the Cloud waitlist.",
      selfHostNow: "Self-host now",
      selfHostHint: "Install steps are in your welcome email.",
      cloudWaitlist: "Cloud waitlist",
      cloudHint: "Hosted Nova is coming. Leave your email.",
      back: "Back",
      successTitle: "You're in.",
      successCopy:
        "We'll email you when hosted Nova is ready. Want to start today? Jump to Self-host on this page.",
      done: "Done",
    },
    waitlist: {
      emailLabel: "Email address",
      placeholder: "you@company.com",
      submit: "Continue",
      joining: "Joining…",
      success: "You’re in.",
      added: "Added",
      error: "Couldn’t add you. Try again.",
    },
    footer: {
      navLabel: "Footer",
      languagesLabel: "Language",
      links: {
        about: "About",
        support: "Support",
        privacy: "Privacy",
      },
    },
  },
  de: {
    title: "Nova | Eine private Alternative zu Grok Bot",
    description:
      "Nova ist eine private Alternative zu Grok Bot für persistente KI-Teamkollegen, die echte Arbeit erledigen. Deine Keys, dein Modell, deine Maschine.",
    ogImageAlt:
      "Nova. KI-Teamkollegen, die dir wirklich gehören. Deine Keys, dein Modell, deine Maschine.",
    availableLanguage: "German",
    skipToContent: "Zum Inhalt springen",
    nav: {
      home: "Nova-Startseite",
      primary: "Hauptnavigation",
      menu: "Menü",
      product: "Produkt",
      bots: "Bots",
      selfHost: "Self-host",
      plans: "Pläne",
      getStarted: "Loslegen",
    },
    hero: {
      badge: "Privat",
      pill: "Self-hosted",
      heading: "KI-Teamkollegen, die dir wirklich gehören",
      lead: "Nova ist eine private Alternative zu Grok Bot. Gib einem Bot echte Arbeit. Er meldet sich in deinen Tools an, nutzt sie wie du. Er kommt zurück, wenn er dich braucht.",
      getStarted: "Loslegen",
      secondaryCta: "In Aktion sehen",
    },
    selfHost: {
      eyebrow: "Self-hosted",
      heading: "Der Computer gehört dir",
      copy: "Betreibe Nova auf deiner Maschine. Deine Keys, dein Modell, deine Daten.",
      features: [
        {
          title: "Beliebiges Modell, dein Key",
          body: "Richte einen Bot auf Claude, GPT, Grok oder ein lokales Modell aus. Pro Bot wechselbar: der günstige triagiert, der smarte schreibt.",
        },
        {
          title: "Lesbare Routinen",
          body: "Zeig einem Bot einmal einen Workflow. Er speichert eine Routine als Markdown, das du lesen, editieren und committen kannst.",
        },
        {
          title: "Freigaben, die greifen",
          body: "Lege fest, was ein Bot allein darf und worum er fragen muss. Jede Aktion landet in einem Audit-Log, das dir gehört.",
        },
      ],
    },
    roster: {
      eyebrow: "Bot-Vorlagen",
      heading: "Gib jedem Bot eine Aufgabe",
      copy: "Starte einen neuen Bot und er interviewt dich. Ein paar Fragen zur Arbeit, zu deinem Schreibstil und wo sie lebt. Dann legt er los.",
      bots: DE_ROSTER,
    },
    openSource: {
      eyebrow: "Deployment",
      heading: "Keine Preistricks. Nur zwei Wege, es zu betreiben.",
      copy: "Nova ist ein privates Produkt und läuft auf deiner Maschine mit deinen Model-Keys. Nichts ist freigeschaltet, nichts telefoniert nach Hause.",
      selfHostTitle: "Self-host",
      selfHostMeta: "Heute verfügbar",
      selfHostItems: [
        "Docker-Runner und sandboxierter Browser",
        "Eigene Model-Keys mitbringen",
        "Routinen, Memory und Audit-Log",
        "Unbegrenzte Bots, keine Seats, keine Limits",
        "Direkter E-Mail-Support",
      ],
      selfHostGetStarted: "Loslegen",
      cloudTitle: "Cloud",
      cloudBadge: "Demnächst",
      cloudMeta: "Deine Keys, wir betreiben die Computer",
      cloudItems: [
        "Managed Sandboxes, immer an",
        "Deine Keys, dein Model-Spend",
        "Dieselben Bots, dieselben Routinen, keine Migration",
      ],
      getStarted: "Loslegen",
    },
    cta: {
      heading: "Triff deinen ersten Bot",
      copy: "Gib Nova etwas, das du aufgeschoben hast. Lass es den Follow-through übernehmen.",
      getStarted: "Loslegen",
      secondaryCta: "In Aktion sehen",
      privateValue: "Privat",
      selfHostValue: "Self-host",
      stats: [
        { value: "model", label: "Dein Key, dein Modell" },
        { value: "audit", label: "Jede Aktion protokolliert" },
        { value: "private", label: "Keine Seats, keine Gates" },
        { value: "selfHost", label: "Deine Maschine" },
      ],
    },
    getStartedDialog: {
      closeLabel: "Loslegen-Dialog schließen",
      eyebrow: "Loslegen",
      title: "Wie willst du starten?",
      copy: "Self-host auf deiner Maschine, oder auf die Cloud-Warteliste.",
      selfHostNow: "Jetzt self-hosten",
      selfHostHint: "Installationsschritte stehen in deiner Willkommens-E-Mail.",
      cloudWaitlist: "Cloud-Warteliste",
      cloudHint: "Gehostetes Nova kommt. Hinterlasse deine E-Mail.",
      back: "Zurück",
      successTitle: "Du bist dabei.",
      successCopy:
        "Wir mailen dir, wenn gehostetes Nova bereit ist. Heute starten? Zum Self-host-Abschnitt auf dieser Seite.",
      done: "Fertig",
    },
    waitlist: {
      emailLabel: "E-Mail-Adresse",
      placeholder: "du@firma.com",
      submit: "Weiter",
      joining: "Wird eingetragen…",
      success: "Du bist dabei.",
      added: "Hinzugefügt",
      error: "Konnte dich nicht eintragen. Bitte erneut versuchen.",
    },
    footer: {
      navLabel: "Fußzeile",
      languagesLabel: "Sprache",
      links: {
        about: "Über uns",
        support: "Support",
        privacy: "Datenschutz",
      },
    },
  },
  ko: {
    title: "Nova | 프라이빗 Grok Bot 대안",
    description:
      "Nova는 실제 업무를 수행하는 지속형 AI 팀원을 위한 프라이빗 Grok Bot 대안입니다. 키, 모델, 머신, 모두 당신 것.",
    ogImageAlt: "Nova. 진짜로 내 것인 AI 팀원. 키, 모델, 머신, 모두 당신 것.",
    availableLanguage: "Korean",
    skipToContent: "본문으로 건너뛰기",
    nav: {
      home: "Nova 홈",
      primary: "주 메뉴",
      menu: "메뉴",
      product: "제품",
      bots: "봇",
      selfHost: "셀프 호스트",
      plans: "요금제",
      getStarted: "시작하기",
    },
    hero: {
      badge: "비공개",
      pill: "셀프 호스트",
      heading: "진짜로 내 것인 AI 팀원",
      lead: "Nova는 프라이빗 Grok Bot 대안입니다. 봇에게 실제 업무를 맡기세요. 봇이 도구에 로그인하고, 당신처럼 사용하며, 필요할 때 돌아와 묻습니다.",
      getStarted: "시작하기",
      secondaryCta: "실제로 보기",
    },
    selfHost: {
      eyebrow: "셀프 호스트",
      heading: "컴퓨터는 당신 것",
      copy: "당신 머신에서 Nova를 실행하세요. 키, 모델, 데이터는 모두 당신 것.",
      features: [
        {
          title: "어떤 모델이든, 키는 당신 것",
          body: "봇을 Claude, GPT, Grok 또는 로컬 모델에 연결하세요. 봇마다 바꿀 수 있습니다. 저렴한 모델은 분류하고, 똑똑한 모델은 작성합니다.",
        },
        {
          title: "읽을 수 있는 루틴",
          body: "워크플로를 한 번 보여주면 봇이 읽고 수정하고 커밋할 수 있는 Markdown 루틴으로 저장합니다.",
        },
        {
          title: "지키는 승인",
          body: "봇이 혼자 해도 되는 일과 물어야 하는 일을 정하세요. 모든 액션은 당신이 소유한 감사 로그에 남습니다.",
        },
      ],
    },
    roster: {
      eyebrow: "봇 템플릿",
      heading: "봇마다 역할을 주세요",
      copy: "새 봇을 시작하면 인터뷰합니다. 업무, 글쓰기 방식, 작업이 어디에 있는지 몇 가지 질문. 그다음 바로 시작합니다.",
      bots: KO_ROSTER,
    },
    openSource: {
      eyebrow: "배포",
      heading: "가격 트릭 없음. 두 가지 실행 방법만.",
      copy: "Nova는 프라이빗 제품이며, 당신 머신에서 당신 모델 키로 실행됩니다. 잠긴 기능도, 외부로 연락하는 것도 없습니다.",
      selfHostTitle: "셀프 호스트",
      selfHostMeta: "지금 사용 가능",
      selfHostItems: [
        "Docker 러너와 샌드박스 브라우저",
        "모델 키는 직접 가져오기",
        "루틴, 메모리, 감사 로그",
        "봇 무제한, 시트·한도 없음",
        "이메일로 직접 지원",
      ],
      selfHostGetStarted: "시작하기",
      cloudTitle: "Cloud",
      cloudBadge: "곧 출시",
      cloudMeta: "키는 당신 것, 컴퓨터는 우리가 운영",
      cloudItems: [
        "상시 가동 관리형 샌드박스",
        "키와 모델 비용은 당신 것",
        "같은 봇, 같은 루틴, 마이그레이션 없음",
      ],
      getStarted: "시작하기",
    },
    cta: {
      heading: "첫 봇을 만나보세요",
      copy: "미뤄 두었던 일을 Nova에 맡기고, 후속까지 맡기세요.",
      getStarted: "시작하기",
      secondaryCta: "실제로 보기",
      privateValue: "비공개",
      selfHostValue: "셀프 호스트",
      stats: [
        { value: "model", label: "키와 모델은 당신 것" },
        { value: "audit", label: "모든 액션 기록" },
        { value: "private", label: "시트·게이트 없음" },
        { value: "selfHost", label: "당신 머신" },
      ],
    },
    getStartedDialog: {
      closeLabel: "시작하기 대화상자 닫기",
      eyebrow: "시작하기",
      title: "어떻게 시작할까요?",
      copy: "당신 머신에서 셀프 호스트하거나, Cloud 대기열에 등록하세요.",
      selfHostNow: "지금 셀프 호스트",
      selfHostHint: "설치 단계는 환영 이메일에 있습니다.",
      cloudWaitlist: "Cloud 대기열",
      cloudHint: "호스팅 Nova가 곧 옵니다. 이메일을 남겨 주세요.",
      back: "뒤로",
      successTitle: "등록되었습니다.",
      successCopy:
        "호스팅 Nova가 준비되면 메일로 알려 드립니다. 오늘 시작하려면 이 페이지의 셀프 호스트 섹션으로 이동하세요.",
      done: "완료",
    },
    waitlist: {
      emailLabel: "이메일 주소",
      placeholder: "you@company.com",
      submit: "계속",
      joining: "등록 중…",
      success: "등록되었습니다.",
      added: "추가됨",
      error: "등록하지 못했습니다. 다시 시도하세요.",
    },
    footer: {
      navLabel: "푸터",
      languagesLabel: "언어",
      links: {
        about: "소개",
        support: "지원",
        privacy: "개인정보 처리방침",
      },
    },
  },
  zh: {
    title: "Nova | 私有的 Grok Bot 替代品",
    description:
      "Nova 是一个私有的 Grok Bot 替代品，用于运行真正干活的持久化 AI 队友。密钥、模型、机器，都归你所有。",
    ogImageAlt: "Nova：真正属于你的 AI 队友。密钥、模型、机器，都归你所有。",
    availableLanguage: "Chinese",
    skipToContent: "跳到主要内容",
    nav: {
      home: "Nova 首页",
      primary: "主导航",
      menu: "菜单",
      product: "产品",
      bots: "Bot",
      selfHost: "自托管",
      plans: "方案",
      getStarted: "开始使用",
    },
    hero: {
      badge: "私有",
      pill: "自托管",
      heading: "真正属于你的 AI 队友",
      lead: "Nova 是一个私有的 Grok Bot 替代品。把真正的工作交给 Bot：它会登录你的工具，像你一样使用它们，并在需要你时回来询问。",
      getStarted: "开始使用",
      secondaryCta: "看看效果",
    },
    selfHost: {
      eyebrow: "自托管",
      heading: "电脑归你所有",
      copy: "在你自己的机器上运行 Nova。密钥、模型、数据，都归你所有。",
      features: [
        {
          title: "任意模型，密钥归你",
          body: "让 Bot 使用 Claude、GPT、Grok 或本地模型。可按 Bot 切换：用便宜的模型做分流，用聪明的模型写作。",
        },
        {
          title: "可读的例行任务",
          body: "给 Bot 演示一次工作流程，它就会把例行任务保存为纯 Markdown，你可以阅读、编辑并提交到版本库。",
        },
        {
          title: "可靠的审批",
          body: "设定 Bot 可以独立做什么、什么必须先请示。每个操作都会写入归你所有的审计日志。",
        },
      ],
    },
    roster: {
      eyebrow: "Bot 模板",
      heading: "给每个 Bot 分配一份工作",
      copy: "新建一个 Bot，它会先面试你：几个关于工作内容、写作风格和运行位置的问题。然后它就开始干活。",
      bots: ZH_ROSTER,
    },
    openSource: {
      eyebrow: "部署",
      heading: "没有定价套路，只有两种运行方式。",
      copy: "Nova 是一款私有产品，在你自己的机器上用你自己的模型密钥运行。没有功能墙，也不会偷偷外联。",
      selfHostTitle: "自托管",
      selfHostMeta: "现已可用",
      selfHostItems: [
        "Docker 运行器和沙箱浏览器",
        "自带模型密钥",
        "例行任务、记忆和审计日志",
        "Bot 数量不限，无席位、无额度限制",
        "邮件直接支持",
      ],
      selfHostGetStarted: "开始使用",
      cloudTitle: "云端",
      cloudBadge: "即将推出",
      cloudMeta: "密钥归你，电脑由我们运行",
      cloudItems: [
        "托管沙箱，始终在线",
        "密钥归你，模型费用归你",
        "同样的 Bot 和例行任务，无需迁移",
      ],
      getStarted: "开始使用",
    },
    cta: {
      heading: "认识你的第一个 Bot",
      copy: "把一件你一直拖延的事交给 Nova，让它负责跟进到底。",
      getStarted: "开始使用",
      secondaryCta: "看看效果",
      privateValue: "私有",
      selfHostValue: "自托管",
      stats: [
        { value: "model", label: "密钥与模型都是你的" },
        { value: "audit", label: "每个操作都有记录" },
        { value: "private", label: "无席位、无门槛" },
        { value: "selfHost", label: "你的机器" },
      ],
    },
    getStartedDialog: {
      closeLabel: "关闭开始使用对话框",
      eyebrow: "开始使用",
      title: "你想如何开始？",
      copy: "在你的机器上自托管，或加入云端候补名单。",
      selfHostNow: "立即自托管",
      selfHostHint: "安装步骤在欢迎邮件中。",
      cloudWaitlist: "云端候补名单",
      cloudHint: "托管版 Nova 即将推出。留下你的邮箱。",
      back: "返回",
      successTitle: "登记成功。",
      successCopy:
        "托管版 Nova 就绪时我们会邮件通知你。想今天就上手？跳到本页的自托管部分。",
      done: "完成",
    },
    waitlist: {
      emailLabel: "邮箱地址",
      placeholder: "you@company.com",
      submit: "继续",
      joining: "正在登记…",
      success: "登记成功。",
      added: "已添加",
      error: "未能添加你，请重试。",
    },
    footer: {
      navLabel: "页脚",
      languagesLabel: "语言",
      links: {
        about: "关于",
        support: "支持",
        privacy: "隐私",
      },
    },
  },
};

export function getHomeCopy(locale: Locale): HomeCopy {
  return HOME_COPY[locale];
}
