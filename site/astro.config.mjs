import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://nookdeck.app',
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
});
