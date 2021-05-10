import { VNSyncData } from "./VNSyncData";

/**
 * Interface representing a ghost session.
 */
export interface GhostSession {
  /**
   * Timestamp at which the client has left.
   */
  leftAt: number;

  /**
   * Data of the client.
   */
  data: VNSyncData;
}
