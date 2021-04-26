import { Socket } from "socket.io";

/**
 * Interface that represents the Socket IO instance with VNSync-specific fields.
 */
export interface VNSyncSocket extends Socket {
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
}
