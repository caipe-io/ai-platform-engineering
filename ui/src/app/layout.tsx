import { AuthProvider } from "@/components/auth-provider";
import { AgentCompletionNotifier } from "@/components/notifications/AgentCompletionNotifier";
import { ThemeInjector } from "@/components/theme-injector";
import { ThemeProvider } from "@/components/theme-provider";
import { TokenExpiryGuard } from "@/components/token-expiry-guard";
import { ToastProvider } from "@/components/ui/toast";
import { getClientConfigScript,getServerConfig } from "@/lib/config";
import type { Metadata } from "next";
import { IBM_Plex_Sans,Inter,JetBrains_Mono,Source_Sans_3 } from "next/font/google";
import { headers } from "next/headers";
import Script from "next/script";
import "./globals.css";

// Primary font: Inter - Used by OpenAI, clean and highly readable
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
  fallback: ["system-ui", "arial"],
});

// Alternative: Source Sans 3 - Adobe's open source, excellent readability
const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin"],
  display: "swap",
  fallback: ["system-ui", "arial"],
});

// Alternative: IBM Plex Sans - Professional, used by IBM/Carbon
const ibmPlex = IBM_Plex_Sans({
  variable: "--font-ibm-plex",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
  fallback: ["system-ui", "arial"],
});

// Monospace: JetBrains Mono - Best for code, like VSCode
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
  fallback: ["monospace", "Courier New"],
});

/**
 * Dynamic metadata — reads process.env at request time so branding
 * reflects runtime env vars, not build-time values.
 */
export async function generateMetadata(): Promise<Metadata> {
  const cfg = getServerConfig();
  const fullDescription = `${cfg.tagline} - ${cfg.description}`;

  const faviconUrl = cfg.faviconUrl || "/favicon.ico";

  return {
    title: `${cfg.appName} UI`,
    description: fullDescription,
    icons: {
      icon: [
        { url: faviconUrl, sizes: "any" },
      ],
      shortcut: faviconUrl,
      apple: faviconUrl,
    },
    openGraph: {
      title: `${cfg.appName} UI`,
      description: fullDescription,
      url: "https://caipe.example.com",
    },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Force dynamic rendering so config reads process.env at request time,
  // not at build time when env vars are empty.
  await headers();

  const cfg = getServerConfig();

  // Build the XSS-safe JSON for client-side config injection.
  // Only client-safe values are included (no secrets).
  const configScript = getClientConfigScript();
  const initialTheme = JSON.stringify(cfg.defaultTheme).replace(/</g,"\\u003c");
  const themeScript = `(function(){try{var preference=localStorage.getItem("theme")||${initialTheme};var theme=preference;if(theme==="system"){theme=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.setAttribute("data-theme-preference",preference);document.documentElement.setAttribute("data-theme",theme);document.documentElement.style.removeProperty("color-scheme");}catch(_error){}})();`;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Inject client config synchronously before any JS runs */}
        <Script
          dangerouslySetInnerHTML={{
            __html: `window.__APP_CONFIG__=${configScript};`,
          }}
          id="runtime-app-config"
          strategy="beforeInteractive"
        />
        <Script
          dangerouslySetInnerHTML={{ __html: themeScript }}
          id="initial-appearance-theme"
          strategy="beforeInteractive"
        />
      </head>
      <body
        className={`${inter.variable} ${sourceSans.variable} ${ibmPlex.variable} ${jetbrainsMono.variable} font-sans antialiased`}
        data-font-size={cfg.defaultFontSize}
        data-font-family={cfg.defaultFontFamily}
      >
        <AuthProvider>
          <ThemeProvider
            attribute="data-theme"
            defaultTheme={cfg.defaultTheme}
            enableColorScheme={false}
            enableSystem
            disableTransitionOnChange
            themes={["light", "legacy-light", "dark", "midnight", "nord", "tokyo", "cyberpunk", "tron", "matrix"]}
          >
            <ToastProvider>
              <ThemeInjector />
              <TokenExpiryGuard />
              <AgentCompletionNotifier />
              {children}
            </ToastProvider>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
