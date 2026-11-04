/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'radar': 'radar 2.4s cubic-bezier(0, 0, 0.2, 1) infinite',
        'spin-slow': 'spin 6s linear infinite',
      },
      keyframes: {
        radar: {
          '0%': { transform: 'scale(0.92)', opacity: '0.8' },
          '75%, 100%': { transform: 'scale(1.65)', opacity: '0' },
        },
      },
    },
  },
  plugins: [],
};
