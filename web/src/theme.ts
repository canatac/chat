import { createTheme } from '@mui/material/styles';

export const chatColors = {
  surface: '#ffffff',
  background: '#f3f7f7',
  border: '#dce7e7',
  ink: '#142f33',
  muted: '#50666b',
  accent: '#11655c',
  accentSoft: '#e5f3ef',
};

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#128c7e' },
    secondary: { main: '#075e54' },
    background: { default: '#ece5dd', paper: '#ffffff' },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: '"Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
});
