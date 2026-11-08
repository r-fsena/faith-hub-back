// Shared contract. Kept byte-identical in backend, Studio and PWA; covered by contract tests.
export const EXPERIENCE_FLAG = "system.saas_pwa_customization";
export const SCREEN_LABELS = {
  home: "Início",
  welcome: "Boas-vindas",
  auth: "Entrada",
  profile: "Perfil",
  bible: "Bíblia",
  devotionals: "Palavra e estudos",
  cells: "Células",
  prayers: "Orações",
  events: "Eventos",
  store: "Loja",
  giving: "Contribuições",
  volunteers: "Escalas",
  kids: "Kids",
} as const;
export type ScreenId = keyof typeof SCREEN_LABELS;
export const PALETTE_LABELS = {
  background: "Fundo da tela",
  surface: "Cartão",
  surfaceMuted: "Superfície secundária",
  border: "Borda",
  text: "Texto principal",
  muted: "Texto secundário",
  primary: "Botão principal",
  onPrimary: "Texto do botão",
  secondary: "Destaque secundário",
  header: "Fundo do cabeçalho",
  headerText: "Texto do cabeçalho",
  navigation: "Fundo da navegação",
  navigationText: "Texto da navegação",
  navigationActive: "Item ativo",
  input: "Fundo dos campos",
  heroText: "Texto sobre imagem",
} as const;
export type Palette = Record<keyof typeof PALETTE_LABELS, string>;
export const BLOCK_LABELS = {
  hero: "Destaque principal",
  shortcuts: "Atalhos",
  kids: "Famílias e Kids",
  devotional: "Palavra em destaque",
  events: "Agenda em destaque",
} as const;
export const COPY_DEFAULTS: Record<string, string> = {
  "home.title": "Sua comunidade",
  "home.subtitle": "Conecte-se, participe e viva sua fé.",
  "home.shortcuts": "Serviços e comunidade",
  "home.devotional": "Palavra para hoje",
  "home.events": "Programação da comunidade",
  "welcome.title": "Viva o propósito da sua vida em comunidade",
  "welcome.subtitle": "Uma igreja para caminhar com você.",
  "auth.title": "Entre na sua comunidade",
  "auth.subtitle": "Acesse com seu e-mail e senha.",
  "auth.action": "Entrar",
  "profile.title": "Meu perfil",
  "profile.subtitle": "Seu acesso e sua comunidade.",
  "bible.title": "Bíblia Sagrada",
  "bible.subtitle": "Leia e medite na Palavra.",
  "devotionals.title": "Palavra & Estudo",
  "devotionals.subtitle": "Mensagens para fortalecer sua fé.",
  "cells.title": "Células & Redes",
  "cells.subtitle": "Encontre seu pequeno grupo.",
  "prayers.title": "Mural de Oração",
  "prayers.subtitle": "Compartilhe e ore com sua comunidade.",
  "events.title": "Eventos & Cursos",
  "events.subtitle": "Participe da programação da igreja.",
  "store.title": "Loja Oficial",
  "store.subtitle": "Conheça os produtos da sua comunidade.",
  "giving.title": "Dízimos & Ofertas",
  "giving.subtitle": "Contribua com a missão da igreja.",
  "volunteers.title": "Escalas & Servir",
  "volunteers.subtitle": "Sirva com seus dons e talentos.",
  "kids.title": "Ministério Kids",
  "kids.subtitle": "Cuidado e acolhimento para sua família.",
  "navigation.home": "Início",
  "navigation.devotionals": "Palavra",
  "navigation.cells": "Células",
  "navigation.store": "Loja",
  "navigation.profile": "Perfil",
  "shortcuts.broadcasts": "Cultos ao Vivo",
  "shortcuts.devotionals": "Palavra & Estudo",
  "shortcuts.cells": "Células & Redes",
  "shortcuts.store": "Loja Oficial",
  "shortcuts.giving": "Dízimos & Ofertas",
  "shortcuts.events": "Eventos & Cursos",
  "shortcuts.bible": "Bíblia Sagrada",
  "shortcuts.prayers": "Mural de Oração",
  "shortcuts.volunteers": "Escalas & Servir",
};
const light: Palette = {
  background: "#f8fafc",
  surface: "#ffffff",
  surfaceMuted: "#f1f5f9",
  border: "#cbd5e1",
  text: "#0f172a",
  muted: "#475569",
  primary: "#0f766e",
  onPrimary: "#ffffff",
  secondary: "#14b8a6",
  header: "#ffffff",
  headerText: "#0f172a",
  navigation: "#ffffff",
  navigationText: "#475569",
  navigationActive: "#0f766e",
  input: "#ffffff",
  heroText: "#ffffff",
};
const dark: Palette = {
  background: "#090d16",
  surface: "#111827",
  surfaceMuted: "#1e293b",
  border: "#475569",
  text: "#f8fafc",
  muted: "#cbd5e1",
  primary: "#2dd4bf",
  onPrimary: "#062e2a",
  secondary: "#5eead4",
  header: "#111827",
  headerText: "#f8fafc",
  navigation: "#111827",
  navigationText: "#cbd5e1",
  navigationActive: "#5eead4",
  input: "#1e293b",
  heroText: "#ffffff",
};
export interface ExperienceConfig {
  schema_version: 1;
  template_id: "classic" | "welcoming" | "contemporary";
  theme: {
    default_mode: "LIGHT" | "DARK" | "AUTO";
    light: Palette;
    dark: Palette;
    typography: { font: "jakarta" | "system" | "serif"; scale: number };
    components: {
      radius: number;
      spacing: number;
      shadow: "none" | "soft" | "strong";
    };
  };
  identity: {
    name: string;
    tagline: string;
    logo_url: string;
    banner_url: string;
  };
  copy: Record<string, string>;
  home: {
    blocks: Array<{
      id: keyof typeof BLOCK_LABELS;
      visible: boolean;
      variant: "default" | "compact" | "featured";
    }>;
    columns: 2 | 3;
  };
  screens: Partial<
    Record<
      ScreenId,
      { palette?: Partial<Palette>; image_url?: string; overlay?: number }
    >
  >;
}
export type ExperiencePatch = Record<string, any>;
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
export function merge<T>(base: T, patch: any): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    return clone(base);
  const out: any = clone(base);
  for (const k of Object.keys(patch)) {
    if (["__proto__", "constructor", "prototype"].includes(k)) continue;
    const v = patch[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v)
        ? merge(out[k] || {}, v)
        : clone(v);
  }
  return out;
}
export function defaultExperience(branding: any = {}): ExperienceConfig {
  return {
    schema_version: 1,
    template_id: "classic",
    theme: {
      default_mode: ["LIGHT", "DARK", "AUTO"].includes(branding.theme_mode)
        ? branding.theme_mode
        : "LIGHT",
      light: {
        ...light,
        primary: validHex(branding.primary_color)
          ? branding.primary_color
          : light.primary,
        secondary: validHex(branding.secondary_color)
          ? branding.secondary_color
          : light.secondary,
      },
      dark: { ...dark },
      typography: { font: "jakarta", scale: 1 },
      components: { radius: 18, spacing: 16, shadow: "soft" },
    },
    identity: {
      name: branding.church_name || "",
      tagline: branding.tagline || branding.slogan || "",
      logo_url: branding.logo_icon_url || "",
      banner_url: branding.banner_url || "",
    },
    copy: {},
    home: {
      blocks: Object.keys(BLOCK_LABELS).map((id) => ({
        id: id as keyof typeof BLOCK_LABELS,
        visible: true,
        variant: "default",
      })),
      columns: 3,
    },
    screens: {},
  };
}
export const validHex = (v: unknown): v is string =>
  typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
function luminance(hex: string) {
  const c = hex
    .slice(1)
    .match(/../g)!
    .map((n) => parseInt(n, 16) / 255)
    .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
export function contrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export const onColor = (hex: string) =>
  contrast(hex, "#ffffff") >= contrast(hex, "#0f172a") ? "#ffffff" : "#0f172a";
export interface ContrastIssue {
  mode: "light" | "dark";
  screen: ScreenId | "global";
  foreground: keyof Palette;
  background: keyof Palette;
  message: string;
}
export function contrastDetails(config: ExperienceConfig) {
  const issues: ContrastIssue[] = [];
  for (const mode of ["light", "dark"] as const) {
    for (const [screen, p] of [
      ["global", config.theme[mode]],
      ...Object.entries(config.screens).map(([id, v]) => [
        id,
        { ...config.theme[mode], ...v?.palette },
      ]),
    ] as Array<[ScreenId | "global", Palette]>) {
      for (const [fg, bg] of [
        ["text", "background"],
        ["text", "surface"],
        ["muted", "surface"],
        ["onPrimary", "primary"],
        ["headerText", "header"],
        ["navigationText", "navigation"],
        ["navigationActive", "navigation"],
      ] as Array<[keyof Palette, keyof Palette]>)
        if (contrast(p[fg], p[bg]) < 4.5)
          issues.push({
            mode,
            screen,
            foreground: fg,
            background: bg,
            message: `${mode === "light" ? "Claro" : "Escuro"} · ${screen} · ${PALETTE_LABELS[fg]} / ${PALETTE_LABELS[bg]}`,
          });
    }
  }
  return issues;
}
export function contrastIssues(config: ExperienceConfig) {
  return contrastDetails(config).map((issue) => issue.message);
}
export function preset(id: ExperienceConfig["template_id"]) {
  const p = defaultExperience();
  p.template_id = id;
  if (id === "welcoming") {
    Object.assign(p.theme.light, {
      background: "#fff7ed",
      surface: "#ffffff",
      primary: "#92400e",
      onPrimary: "#ffffff",
      secondary: "#c2410c",
      navigationActive: "#92400e",
    });
    p.theme.components.radius = 24;
    p.theme.typography.font = "serif";
  }
  if (id === "contemporary") {
    Object.assign(p.theme.light, {
      background: "#eef2ff",
      primary: "#4338ca",
      secondary: "#6366f1",
      navigationActive: "#4338ca",
    });
    p.theme.components.radius = 12;
    p.theme.components.shadow = "strong";
  }
  return p;
}
export function validatePatch(
  input: unknown,
  allowLegacyAssets = false,
): ExperiencePatch {
  const fail = (path: string): never => {
    throw Error(`Configuração inválida: ${path}`);
  };
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    JSON.stringify(input).length > (allowLegacyAssets ? 5000000 : 64000)
  )
    fail("documento");
  const plain = (v: any, p: string) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(p);
    return v;
  };
  const keys = (v: any, allowed: string[], p: string) => {
    plain(v, p);
    for (const k of Object.keys(v))
      if (
        !allowed.includes(k) ||
        ["__proto__", "constructor", "prototype"].includes(k)
      )
        fail(`${p}.${k}`);
  };
  const text = (v: any, p: string, max = 300) => {
    if (
      typeof v !== "string" ||
      v.length > max ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)
    )
      fail(p);
  };
  const url = (v: any, p: string) => {
    if (
      allowLegacyAssets &&
      typeof v === "string" &&
      v.length <= 4000000 &&
      /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,[a-z0-9+/]+=*$/i.test(
        v,
      )
    )
      return;
    text(v, p, 2000);
    if (v === "") return;
    try {
      const u = new URL(v);
      if (u.protocol !== "https:" || u.username || u.password) fail(p);
    } catch {
      fail(p);
    }
  };
  const number = (v: any, min: number, max: number, p: string) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
      fail(p);
  };
  const enumeration = (v: any, list: any[], p: string) => {
    if (!list.includes(v)) fail(p);
  };
  const palette = (v: any, p: string) => {
    keys(v, Object.keys(PALETTE_LABELS), p);
    for (const k of Object.keys(v)) if (!validHex(v[k])) fail(`${p}.${k}`);
  };
  const v: any = input;
  keys(
    v,
    [
      "schema_version",
      "template_id",
      "theme",
      "identity",
      "copy",
      "home",
      "screens",
    ],
    "raiz",
  );
  if (v.schema_version !== undefined && v.schema_version !== 1) fail("versão");
  if (v.template_id !== undefined)
    enumeration(
      v.template_id,
      ["classic", "welcoming", "contemporary"],
      "modelo",
    );
  if (v.theme !== undefined) {
    keys(
      v.theme,
      ["default_mode", "light", "dark", "typography", "components"],
      "tema",
    );
    const t = v.theme;
    if (t.default_mode !== undefined)
      enumeration(t.default_mode, ["LIGHT", "DARK", "AUTO"], "modo");
    for (const m of ["light", "dark"]) if (t[m] !== undefined) palette(t[m], m);
    if (t.typography !== undefined) {
      keys(t.typography, ["font", "scale"], "tipografia");
      if (t.typography.font !== undefined)
        enumeration(t.typography.font, ["jakarta", "system", "serif"], "fonte");
      if (t.typography.scale !== undefined)
        number(t.typography.scale, 0.85, 1.3, "escala");
    }
    if (t.components !== undefined) {
      keys(t.components, ["radius", "spacing", "shadow"], "componentes");
      if (t.components.radius !== undefined)
        number(t.components.radius, 0, 32, "raio");
      if (t.components.spacing !== undefined)
        number(t.components.spacing, 8, 28, "espaçamento");
      if (t.components.shadow !== undefined)
        enumeration(t.components.shadow, ["none", "soft", "strong"], "sombra");
    }
  }
  if (v.identity !== undefined) {
    keys(
      v.identity,
      ["name", "tagline", "logo_url", "banner_url"],
      "identidade",
    );
    for (const k of Object.keys(v.identity))
      k.endsWith("_url") ? url(v.identity[k], k) : text(v.identity[k], k, 180);
  }
  if (v.copy !== undefined) {
    keys(v.copy, Object.keys(COPY_DEFAULTS), "textos");
    for (const k of Object.keys(v.copy))
      text(
        v.copy[k],
        k,
        k.endsWith(".title") ||
          k.startsWith("navigation.") ||
          k.startsWith("shortcuts.")
          ? 80
          : 300,
      );
  }
  if (v.home !== undefined) {
    keys(v.home, ["blocks", "columns"], "início");
    if (v.home.columns !== undefined)
      enumeration(v.home.columns, [2, 3], "colunas");
    if (v.home.blocks !== undefined) {
      if (
        !Array.isArray(v.home.blocks) ||
        v.home.blocks.length !== Object.keys(BLOCK_LABELS).length
      )
        fail("blocos");
      const seen = new Set();
      for (const b of v.home.blocks) {
        keys(b, ["id", "visible", "variant"], "bloco");
        enumeration(b.id, Object.keys(BLOCK_LABELS), "bloco.id");
        if (seen.has(b.id) || typeof b.visible !== "boolean") fail("bloco");
        seen.add(b.id);
        enumeration(b.variant, ["default", "compact", "featured"], "variante");
      }
    }
  }
  if (v.screens !== undefined) {
    keys(v.screens, Object.keys(SCREEN_LABELS), "telas");
    for (const id of Object.keys(v.screens)) {
      const s = v.screens[id];
      keys(s, ["palette", "image_url", "overlay"], id);
      if (s.palette !== undefined) palette(s.palette, id);
      if (s.image_url !== undefined) url(s.image_url, id);
      if (s.overlay !== undefined) number(s.overlay, 0, 0.85, id);
    }
  }
  return clone(v);
}
export function resolveExperience(
  base: any,
  ...patches: any[]
): ExperienceConfig {
  let result = defaultExperience(base);
  for (const patch of patches)
    if (patch) result = merge(result, validatePatch(patch, true));
  return result;
}
export function paletteFor(
  config: ExperienceConfig,
  mode: "light" | "dark",
  screen: ScreenId,
): Palette {
  return { ...config.theme[mode], ...config.screens[screen]?.palette };
}

// An entirely achromatic palette opts the full UI (including legacy modules) into monochrome.
export function isMonochromeExperience(config: ExperienceConfig): boolean {
  return [config.theme.light, config.theme.dark].every(palette =>
    Object.values(palette).every(value => /^#([0-9a-f]{2})\1\1$/i.test(value)) && palette.background.toLowerCase() !== palette.text.toLowerCase()
  );
}
export function monochromePalettes(): Pick<ExperienceConfig['theme'], 'light' | 'dark'> {
  return {
    light: { background: '#ffffff', surface: '#ffffff', surfaceMuted: '#f5f5f5', border: '#d4d4d4', text: '#000000', muted: '#404040', primary: '#000000', onPrimary: '#ffffff', secondary: '#000000', header: '#ffffff', headerText: '#000000', navigation: '#ffffff', navigationText: '#404040', navigationActive: '#000000', input: '#ffffff', heroText: '#ffffff' },
    dark: { background: '#000000', surface: '#000000', surfaceMuted: '#141414', border: '#404040', text: '#ffffff', muted: '#d4d4d4', primary: '#ffffff', onPrimary: '#000000', secondary: '#ffffff', header: '#000000', headerText: '#ffffff', navigation: '#000000', navigationText: '#d4d4d4', navigationActive: '#ffffff', input: '#000000', heroText: '#ffffff' },
  };
}
