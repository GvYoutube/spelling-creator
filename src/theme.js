import { createTheme } from "@mui/material/styles";

// A calm, high-contrast palette suited to a classroom / learning tool.
const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#3b5bdb" },
    secondary: { main: "#f06595" },
    background: { default: "#f4f6fb", paper: "#ffffff" },
  },
  typography: {
    fontFamily: 'Roboto, "Helvetica Neue", Arial, sans-serif',
    h5: { fontWeight: 700 },
    h6: { fontWeight: 600 },
  },
  shape: { borderRadius: 12 },
});

export default theme;
