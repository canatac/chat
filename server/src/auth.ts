import { compareSync, hashSync } from 'bcryptjs';
import jwt from 'jsonwebtoken';

export interface TokenPayload {
  sub: number;
  name: string;
  version?: number;
}

export function hashPassword(password: string): string {
  return hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return compareSync(password, hash);
}

export function signToken(user: { id: number; name: string; version?: number }, secret: string): string {
  return jwt.sign({ sub: user.id, name: user.name, version: user.version ?? 0 } satisfies TokenPayload, secret, { expiresIn: '30d', algorithm: 'HS256' });
}

export function verifyToken(token: string, secret: string): TokenPayload {
  return jwt.verify(token, secret, { algorithms: ['HS256'] }) as unknown as TokenPayload;
}
