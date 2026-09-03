import type { Metadata } from "next";
import { Archivo_Black, Public_Sans } from "next/font/google";

import { SignBar } from "@/components/signage/SignBar";
import { SessionProvider } from "@/components/state/session";
import "./globals.css";

/** Signage voice: one face for the shouting, one for the reading. */
const archivoBlack = Archivo_Black({
  variable: "--font-archivo-black",
  weight: "400",
  subsets: ["latin"],
  display: "swap",
});

const publicSans = Public_Sans({
  variable: "--font-public-sans",
  weight: ["400", "600", "700"],
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Chancery — power of attorney for AI agents",
  description:
    "A human signs a writ saying exactly which irreversible acts an agent may commit to on their behalf. Every act is re-checked against that document and answered allow or deny, citing the clause and the page.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${publicSans.variable} ${archivoBlack.variable}`}>
        <SessionProvider>
          <a className="skip" href="#main">
            Skip to the content
          </a>
          <SignBar />
          <main id="main">{children}</main>
          <footer className="foot">
            <div className="wrap">
              <p>
                Chancery — an AI can draft it; only a human can commit to it. Verdicts on every
                surface come from the same pure decision engine, which fails closed: every unknown
                denies.
              </p>
              <p className="foot__thin">
                Public DNS is queried live over DoH against Cloudflare, with Google as a transport
                fallback only. The demo agent&rsquo;s zone is served by this process and says so
                wherever it appears.
              </p>
            </div>
          </footer>
        </SessionProvider>
      </body>
    </html>
  );
}
