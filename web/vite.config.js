import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), ['VITE_', 'NEXT_PUBLIC_'])

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'self-hosted-html',
        transformIndexHtml: {
          order: 'post',
          handler(html) {
            // Exclude preview-only scripts and external recording services.
            const clean = html.replace(/<script\b[^>]*\bdata-(?:arena-(?:recording|views)|element-picker)[^>]*>[\s\S]*?<\/script>/gi, '')
            // Vite's development refresh preamble uses inline scripts.
            return command === 'serve'
              ? clean.replace(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi, '')
              : clean
          },
        },
      },
    ],
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    define: Object.fromEntries(
      Object.entries(env).map(([key, value]) => [`process.env.${key}`, JSON.stringify(value)]),
    ),
  }
})
