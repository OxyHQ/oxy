/** @type {import('tailwindcss').Config} */
const { bloomTailwindPreset } = require('@oxy.so/bloom/tailwind-preset');

module.exports = {
  presets: [bloomTailwindPreset],
  content: [
    './app/**/*.{js,jsx,ts,tsx}',
    './components/**/*.{js,jsx,ts,tsx}',
    '../../node_modules/@oxy.so/services/lib/**/*.{js,jsx}',
    '../services/src/**/*.{ts,tsx}',
    '../../node_modules/@oxy.so/bloom/lib/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'sans-serif'] },
      colors: {
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
        muted: { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
        accent: { DEFAULT: 'var(--accent)' },
        card: { DEFAULT: 'var(--card)' },
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
