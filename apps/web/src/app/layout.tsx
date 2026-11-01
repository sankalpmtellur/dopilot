import { THEME_INIT_SCRIPT } from '@dopilot/ui/theme-script';
import { GeistSans } from 'geist/font/sans';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'Dopilot',
  description: 'Open-source, voice-controlled AI browser agent for Chrome and Brave.',
  icons: '/icon.svg',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The theme script sets data-theme before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className={`${GeistSans.className} antialiased`}>{children}</body>
    </html>
  );
}
