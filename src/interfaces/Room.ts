import { Connection } from "./Connection";

/**
 * Interface representing a room on the server.
 */
export interface Room {
  /**
   * The list of connections that belong to the room.
   */
  connections: Connection[];

  /**
   * The connection that belongs to the host of the room.
   */
  host: Connection;
}
