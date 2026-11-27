import type { MetadataRoute } from 'next';
import { APP_NAME } from '@/lib/api';

/** Lets the POS be installed as an app on a tablet or computer, opening full screen like one. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: APP_NAME,
    short_name: 'POS',
    description: 'Point of sale terminal',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ea580c',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
