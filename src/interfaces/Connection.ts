import { Socket } from "socket.io";

/**
 * Interface reprsenting a connection to the server.
 */
export interface Connection {
  /**
   * The Socket.io instance.
   */
  socket: Socket;

  /**
   * The username associated with the connection.
   */
  username: string;

  /**
   * A boolean which denotes whether the connection is a room host.
   */
  isHost: boolean;

  /**
   * The name of the room that the connection belongs to.
   */
  roomName: string;

  /**
   * A boolean which dentoes the ready state of the connection.
   */
  isReady: boolean;
}
