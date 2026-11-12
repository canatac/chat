export interface User {
  id: number;
  name: string;
  isBot: boolean;
}

export interface Message {
  id: number;
  content: string;
  createdAt: string;
  user: User;
}
