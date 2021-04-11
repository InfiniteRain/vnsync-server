import { Socket } from "socket.io";

export interface Connection {
  socket: Socket;
  username: string;
  isHost: boolean;
  room: string;
  isReady: boolean;
}
