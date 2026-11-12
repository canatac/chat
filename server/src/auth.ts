import { compareSync, hashSync } from 'bcryptjs';
import jwt from 'jsonwebtoken';

export interface TokenPayload {
  sub: number;
  name: string;
}

export function hashPassword(password: string): string {
  return hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return compareSync(password, hash);
}

export function signToken(user: { id: number; name: string }, secret: string): string {
  return jwt.sign({ sub: user.id, name: user.name } satisfies TokenPayload, secret, { expiresIn: '30d' });
}

export function verifyToken(token: string, secret: string): TokenPayload {
  return jwt.verify(token, secret) as unknown as TokenPayload;
}
