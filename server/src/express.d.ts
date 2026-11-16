declare namespace Express {
  interface Request {
    user?: { id: number; name: string; role: import('./rooms.js').Role };
  }
}
