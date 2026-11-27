import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';

const inter = Inter({ variable: '--font-inter', subsets: ['latin'] });

// Not for search engines: this app is for the vendor's own staff.
export const metadata: Metadata = { title: 'Platform admin', description: 'Restaurants on the platform', robots: { index: false, follow: false } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} h-full`}>
      <body className="min-h-full bg-canvas">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
