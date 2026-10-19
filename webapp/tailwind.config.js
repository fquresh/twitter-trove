/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Light surface palette, plus a midnight palette retained for dark mode.
        ink: {
          900: '#0b1120',
          850: '#0f172a',
          800: '#111827',
          700: '#1e293b',
          600: '#334155',
          500: '#475569',
          400: '#64748b',
          300: '#94a3b8',
          200: '#cbd5e1',
          100: '#e2e8f0',
          50:  '#f1f5f9',
        },
        // Light surfaces - the new default theme.
        canvas: {
          50:  '#ffffff',
          100: '#fafafa',
          150: '#f5f5f7',
          200: '#eeeef1',
          300: '#e4e4e7',
        },
        // Primary accent: violet (matches the design recording).
        accent: {
          50:  '#f5f3ff',
          100: '#ede9fe',
          200: '#ddd6fe',
          300: '#c4b5fd',
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
          800: '#5b21b6',
          900: '#4c1d95',
        },
        // Secondary accent kept for charts that need a complementary hue.
        cyan: {
          400: '#22d3ee',
          500: '#06b6d4',
        },
        // iOS system palette used for the mobile card UI (chart series, dots).
        ios: {
          blue: '#007aff',
          green: '#34c759',
          purple: '#af52de',
          pink: '#ff2d55',
          orange: '#ff9500',
          yellow: '#ffcc00',
          teal: '#5ac8fa',
          indigo: '#5856d6',
          gray: '#8e8e93',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
        display: ['"Inter Tight"', 'Inter', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        glass: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 10px 30px -15px rgba(0,0,0,0.6)',
        soft: '0 1px 2px rgba(15, 23, 42, 0.06), 0 8px 24px -12px rgba(15, 23, 42, 0.12)',
        nav:  '0 8px 32px -12px rgba(15, 23, 42, 0.35), 0 2px 6px -2px rgba(15, 23, 42, 0.18)',
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
};
