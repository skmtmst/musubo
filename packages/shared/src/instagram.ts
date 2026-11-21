export interface InstagramConnectionStatus {
  state: 'unconfigured' | 'disconnected' | 'connected' | 'expired';
  replyEnabled: false;
  dmReconnectRequired?: boolean;
  connection?: {
    pageId: string;
    instagramId: string;
    pageName: string;
    username: string | null;
    expiresAt: string;
    dataAccessExpiresAt: string | null;
    version: number;
    syncedAt: string | null;
  };
}
export interface InstagramOAuthPage {
  pageId: string;
  pageName: string;
  instagramId: string;
}
export interface InstagramProfile {
  id: string;
  username?: string;
  name?: string;
  biography?: string;
  profile_picture_url?: string;
  followers_count?: number;
  media_count?: number;
}
export interface InstagramPost {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
}
export interface InstagramReceivedMessage {
  id: string;
  senderId: string;
  recipientId: string;
  content: string;
  receivedAt: string;
  attachments: Array<{ type: string; url: string | null }>;
}
