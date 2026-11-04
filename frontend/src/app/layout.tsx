import type { Metadata } from "next";
import "./globals.css";
import { LocaleProvider } from "@/lib/locale";

export const metadata: Metadata = {
  title: "Sarjy — A little help, out loud",
  icons: { icon: "/icon.svg" },
  description:
    "Your personal voice assistant. Talk, think, and plan your day with a little help from Sarjy.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <LocaleProvider>{children}</LocaleProvider>
      </body>
    </html>
  );
}
