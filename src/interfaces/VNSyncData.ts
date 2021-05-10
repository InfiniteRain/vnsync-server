/**
 * Interface representing VNSync socket data.
 */
export interface VNSyncData {
  /**
   * The session ID.
   */
  sessionId: string;

  /**
   * The username associated with the client.
   */
  username: string;

  /**
   * A boolean which denotes whether the client is a room host.
   */
  isHost: boolean;

  /**
   * The room that the client belongs to.
   */
  room: string | null;

  /**
   * A boolean which denotes the ready state of the client.
   */
  isReady: boolean;

  /**
   * An array of strings representing the host's clipboard history.
   */
  clipboard: string[];
}
