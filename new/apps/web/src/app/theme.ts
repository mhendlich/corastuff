import { createTheme, rem } from "@mantine/core";

export const theme = createTheme({
  primaryColor: "violet",
  primaryShade: 6,
  defaultRadius: "md",
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
  headings: {
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
    fontWeight: "650"
  },
  spacing: {
    xs: rem(10)
  }
});

