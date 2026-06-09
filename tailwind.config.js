/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        orca: {
          50:  '#f0f7ff',
          100: '#e0efff',
          200: '#b9dcff',
          300: '#7cc0ff',
          400: '#36a1ff',
          500: '#0a84ff',
          600: '#0065df',
          700: '#0050b3',
          800: '#004494',
          900: '#003a7a',
          950: '#002453',
        },
      },
      fontFamily: {
        sans: ['"Inter"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
