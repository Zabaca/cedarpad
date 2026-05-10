/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // cedarpad palette: warm wood-bark backdrop, cedar accent
        bark: {
          900: "#1c1714",
          800: "#241d18",
          700: "#2e251f",
          600: "#3a2f27",
          500: "#4a3c32",
          400: "#6b594c",
          300: "#9a8676",
          200: "#c5b6a8",
          100: "#e8ded3",
        },
        cedar: {
          600: "#a85a2a",
          500: "#c46a36",
          400: "#d98a55",
          300: "#e8a777",
        },
        moss: {
          500: "#6b8e4e",
          400: "#8baa6b",
        },
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
