export type SessionToken = {
  accessToken: string;
  refreshToken: string;
  uid: string;
};

export interface SyncPair {
  id: string;
  local: string;
  remote: string;
}

export interface SyncState {
  syncPairId: string;
  localPath: string;
  remotePath: string;
  lastSyncMtime: string;
  lastSyncHash: string;
  state: "synced" | "conflict" | "error" | "pending";
}

export interface ConflictRecord {
  original: string;
  conflictCopy: string;
}

export interface SyncPairStatus {
  syncPair: SyncPair;
  state: SyncState["state"];
  lastSyncMtime: string | null;
}

// SyncStateRecord is the DB row shape — identical to SyncState
export type SyncStateRecord = SyncState;

export interface DriveItem {
  id: string;
  name: string;
  remotePath: string;
  isFolder: boolean;
  mtime: string; // ISO 8601
  size: number;
}

export interface DriveItemMetadata {
  id: string;
  name: string;
  remotePath: string;
  isFolder: boolean;
  mtime: string;
  size: number;
  hash: string; // SHA-256 hex
}
