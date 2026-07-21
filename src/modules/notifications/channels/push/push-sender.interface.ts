export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushSender {
  send(message: PushMessage): Promise<void>;
}

export const PUSH_SENDER = Symbol('PUSH_SENDER');
