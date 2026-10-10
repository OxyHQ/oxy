export interface SessionData {
  sessionId: string;
  deviceId: string;
  lastActive: Date;
  expiresAt: Date;
}

export interface ClientSession {
  sessionId: string;
  deviceId: string;
  deviceName?: string;
  isActive: boolean;
  userId: string;
}

export interface SessionAuthResponse {
  sessionId: string;
  deviceId: string;
  expiresAt: string;
  accessToken?: string;
  user: {
    id: string;
    username?: string; // Optional - users may not have a username set
    avatar?: string; // file id
  };
}
